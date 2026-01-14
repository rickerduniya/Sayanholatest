using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Sayanho.Core.Models;

namespace Sayanho.Core.Logic
{
    public class AutoRatingService
    {
        private List<CanvasItem> allItems;
        private List<Connector> allConnectors;
        private NetworkAnalyzer networkAnalyzer;
        private Dictionary<CanvasItem, double> maxCurrentPerItem;
        private Dictionary<string, Dictionary<string, SortedDictionary<double, int>>> cableCapacityTables;
        private Dictionary<double, int> wireCapacityTable;
        private List<string> _processLogs = new List<string>();

        private void LogProcess(string message)
        {
            _processLogs.Add(message);
            // Also log to console for debugging
            // Console.WriteLine(message); 
        }

        public (List<CanvasSheet> Sheets, string Log, bool Success) ExecuteAutoRating()
        {
            _processLogs.Clear();
            try
            {
                // Validate path existence first
                if (!HasValidSourceToLoadPath())
                {
                    LogProcess("Error: No valid path found from Source to Load.");
                    return (new List<CanvasSheet>(), string.Join("\n", _processLogs), false);
                }

                AutoSetRatings();
                
                // Re-construct the sheets list with the modified items
                // Note: The items are modified in-place within allItems/allConnectors, 
                // which are references to the objects inside the original sheets dict.
                // We need to return the modified sheets structure.
                
                // (Since we modified the objects in place, the 'sheets' passed in constructor are already updated.
                // However, we need to make sure we return *that* list.)
                // But wait, the constructor didn't store the list of sheets, it flattened them into valid lists.
                // We should store the sheets reference in the class or just rely on the fact that caller has them?
                // The caller (API controller) instantiates this service. We need to be able to return the modified sheets.
                // Ah, the controller doesn't get the modified sheets back easily unless we stored them.
                
                return (_sheets, string.Join("\n", _processLogs), true);
            }
            catch (Exception ex)
            {
                LogProcess($"CRITICAL ERROR: {ex.Message}");
                LogProcess(ex.StackTrace);
                return (new List<CanvasSheet>(), string.Join("\n", _processLogs), false);
            }
        }

        private List<CanvasSheet> _sheets;

        public AutoRatingService(List<CanvasSheet> sheets)
        {
            _sheets = sheets;
            allItems = new List<CanvasItem>();
            allConnectors = new List<Connector>();
            maxCurrentPerItem = new Dictionary<CanvasItem, double>();

            // Collect items and connectors from all sheets
            foreach (var sheet in sheets)
            {
                allItems.AddRange(sheet.CanvasItems);
                allConnectors.AddRange(sheet.StoredConnectors);
            }

            // Reconstruct SourceItem and TargetItem references in connectors
            // (they might be null due to ReferenceHandler.IgnoreCycles during JSON deserialization)
            ReconstructConnectorReferences();

            networkAnalyzer = new NetworkAnalyzer(sheets);
            
            // Load cable capacity tables for cable auto-rating
            cableCapacityTables = DatabaseLoader.LoadCableCapacityTables();
            
            // Load wire capacity table for wire auto-rating
            wireCapacityTable = DatabaseLoader.LoadWireCapacityTable();
        }

        /// <summary>
        /// Reconstructs SourceItem and TargetItem references in connectors after JSON deserialization
        /// </summary>
        private void ReconstructConnectorReferences()
        {
            // Create a lookup dictionary for items by UniqueID
            var itemLookup = new Dictionary<string, CanvasItem>();
            foreach (var item in allItems)
            {
                itemLookup[item.UniqueID.ToString()] = item;
            }

            // Reconstruct references for each connector using the item IDs
            int reconstructed = 0;
            foreach (var connector in allConnectors)
            {
                bool wasNull = connector.SourceItem == null || connector.TargetItem == null;
                
                // Reconstruct SourceItem if null and we have an ID
                if (connector.SourceItem == null && !string.IsNullOrEmpty(connector.SourceItemId))
                {
                    if (itemLookup.ContainsKey(connector.SourceItemId))
                    {
                        connector.SourceItem = itemLookup[connector.SourceItemId];
                    }
                }

                // Reconstruct TargetItem if null and we have an ID
                if (connector.TargetItem == null && !string.IsNullOrEmpty(connector.TargetItemId))
                {
                    if (itemLookup.ContainsKey(connector.TargetItemId))
                    {
                        connector.TargetItem = itemLookup[connector.TargetItemId];
                    }
                }
                
                if (wasNull && connector.SourceItem != null && connector.TargetItem != null)
                {
                    reconstructed++;
                }
            }
            
            // Count how many connectors have valid references
            int validReferences = allConnectors.Count(c => c.SourceItem != null && c.TargetItem != null);
            Console.WriteLine($"Debug: Reconstructed {reconstructed} connectors, {validReferences}/{allConnectors.Count} have valid references");
        }


        /// <summary>
        /// Main method to automatically set ratings for all electrical components
        /// </summary>
        /// <summary>
        /// Main method to automatically set ratings for all electrical components
        /// </summary>
        public void AutoSetRatings()
        {
            try
            {
                // Validate prerequisites
                if (!ValidatePrerequisites())
                {
                    throw new InvalidOperationException("Prerequisites not met for auto-rating");
                }

                LogProcess("Starting auto-rating process...");

                // Step 1: Analyze network to get current flows
                LogProcess("Step 1: Analyzing electrical network...");
                networkAnalyzer.AnalyzeNetwork();

                // Step 2: Calculate maximum current for each component
                LogProcess("Step 2: Calculating maximum currents...");
                CalculateMaxCurrentPerComponent();

                // Step 3: Apply downstream-to-upstream logic
                LogProcess("Step 3: Applying downstream-to-upstream rating logic...");
                ApplyDownstreamToUpstreamRating();

                // Step 4: Apply cable and wire auto-rating (PASS 1)
                LogProcess("Step 4: Applying cable and wire auto-rating (Pass 1)...");
                SetCableAndWireRatings();

                // Step 5: Cumulative Voltage Drop Analysis
                if (ApplicationSettings.Instance.VoltageDropEnabled)
                {
                    LogProcess("Step 5: Cumulative Voltage Drop Analysis...");
                    
                    // Discover all paths from Source to Loads
                    DiscoverVoltagePaths();
                    
                    // Print detailed report for debugging
                    PrintCumulativeVDReport();
                    
                    // Step 6: Iterative approach - if violations exist, try to upsize cables until compliant or max iterations reached
                    if (HasVoltageDropViolation())
                    {
                        LogProcess("Step 6: Re-sizing cables on non-compliant paths (Iterative)...");
                        
                        int maxIterations = 10;
                        int currentIteration = 0;
                        bool violationExists = true;

                        while (violationExists && currentIteration < maxIterations)
                        {
                            currentIteration++;
                            LogProcess($"--- Upsizing Iteration {currentIteration}/{maxIterations} ---");

                            // Get connectors on non-compliant paths
                            var nonCompliantConnectors = GetConnectorsOnNonCompliantPaths();
                            LogProcess($"Found {nonCompliantConnectors.Count} connector(s) on non-compliant paths");
                            
                            if (nonCompliantConnectors.Count == 0)
                            {
                                break; // Should not happen if violationExists is true, but safety check
                            }

                            // Try to upsize cables on non-compliant paths
                            int upsizedCount = 0;
                            foreach (var connector in nonCompliantConnectors)
                            {
                                if (TryUpsizeCableForCumulativeVD(connector))
                                {
                                    upsizedCount++;
                                }
                            }
                            
                            LogProcess($"Upsized {upsizedCount} connector(s) in this iteration");

                            if (upsizedCount == 0)
                            {
                                LogProcess("No further upsizing possible (max size reached or no suitable options).");
                                break;
                            }
                            
                            // Re-analyze paths after upsizing
                            DiscoverVoltagePaths();
                            violationExists = HasVoltageDropViolation();
                            
                            if (violationExists)
                            {
                                LogProcess($"Iteration {currentIteration} complete. Violations still exist.");
                            }
                            else
                            {
                                LogProcess($"Iteration {currentIteration} complete. All paths compliant!");
                            }
                        }
                        
                        LogProcess("Final Cumulative Voltage Drop Report:");
                        PrintCumulativeVDReport();
                        
                        if (HasVoltageDropViolation())
                        {
                            LogProcess("⚠ WARNING: Some paths still exceed voltage drop limits after maximum upsizing attempts!");
                        }
                        else
                        {
                            LogProcess("✓ All paths are now within voltage drop limits.");
                        }
                    }
                    else
                    {
                        LogProcess("✓ All paths are within voltage drop limits.");
                    }
                }
                else
                {
                    LogProcess("Step 5: Voltage Drop check is disabled in settings, skipping cumulative VD analysis.");
                }

                LogProcess("Auto-rating completed successfully.");
            }
            catch (Exception ex)
            {
                LogProcess($"Error in auto-rating: {ex.Message}");
                throw;
            }
        }

        /// <summary>
        /// Validate prerequisites for auto-rating
        /// </summary>
        private bool ValidatePrerequisites()
        {
            // Check if we have electrical components
            var electricalComponents = allItems.Where(IsElectricalComponent).ToList();
            if (!electricalComponents.Any())
            {
                Console.WriteLine("Warning: No electrical components found for auto-rating");
                return false;
            }

            // Check if we have connectors
            if (!allConnectors.Any())
            {
                Console.WriteLine("Warning: No connectors found for network analysis");
                return false;
            }

            // Check if database data is available
            try
            {
                var testData = DatabaseLoader.LoadDefaultPropertiesFromDatabase("MCB", 2);
                if (!testData.Properties.Any())
                {
                    Console.WriteLine("Warning: Database schedule data not available");
                    return false;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Warning: Cannot access database schedule data: {ex.Message}");
                return false;
            }

            LogProcess($"Prerequisites validated: {electricalComponents.Count} electrical components, {allConnectors.Count} connectors");
            return true;
        }

        private bool HasValidSourceToLoadPath()
        {
            LogProcess("Validating network paths...");
            // Use the CalculateNetwork logic to trace paths
            // We can reuse DiscoverVoltagePaths logic but just check if ANY path is found
            
            var sources = allItems.Where(i => i.Name == "Source").ToList();
            if (!sources.Any())
            {
                 LogProcess("Validation Failed: No 'Source' item found.");
                 return false;
            }

            // Simple check: do we have any connected loads?
            // A more robust check runs the full path discovery.
            
            // Let's run a quick path discovery based on VoltageDropCalculator logic
            // We can't easily reuse the private method DiscoverVoltagePaths inside the check without refactoring,
            // but we can call it if strict check is needed.
            // However, VoltageDropCalculator is separate or mixed here? 
            // It seems implemented INSIDE this class in the provided file (based on previous logs showing "Step 5").
            // Wait, checks file structure... yes, VoltageDropCalculator logic seems embedded or copied?
            // Actually, based on the file view, there is a separate VoltageDropCalculator.cs file in the directory list.
            // But the code I viewed has `DiscoverVoltagePaths` call inside `AutoSetRatings`.
            // Let's check if `DiscoverVoltagePaths` is defined in this file.
            
            // Assuming DiscoverVoltagePaths is defined in this file (as it's called in line 139), 
            // we can try to use standard BFS/DFS to check connectivity.
            
            // For now, let's assume if network analysis worked, we have connectivity? 
            // No, network analysis just calculates currents.
            
            // Let's implement a simple BFS from Source
            var visited = new HashSet<CanvasItem>();
            var queue = new Queue<CanvasItem>(sources);
            bool loadFound = false;
            
            while(queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (visited.Contains(current)) continue;
                visited.Add(current);
                
                if (current.Name.Contains("Load") || (current.Properties?.Any(p => p.ContainsKey("Power")) == true && current.Name != "Source"))
                {
                    loadFound = true;
                    // We found at least one load reachable from source
                    // Keep searching to validate *all*? No, requirement is "valid path from source to load".
                    // If at least one exists, we are good to go? User said "if there is no total path".
                    break;
                }
                
                // Find outgoing
                var outgoing = allConnectors.Where(c => c.SourceItem == current).Select(c => c.TargetItem).Where(i => i != null);
                foreach(var next in outgoing)
                {
                    if (!visited.Contains(next)) queue.Enqueue(next);
                }
            }
            
            if (!loadFound)
            {
                LogProcess("Validation Failed: No valid path found from any Source to any Load.");
                return false;
            }
            
            LogProcess("Network path validation successful.");
            return true;
        }

        /// <summary>
        /// Calculate the maximum current flowing through each electrical component
        /// </summary>
        private void CalculateMaxCurrentPerComponent()
        {
            foreach (var item in allItems)
            {
                if (!IsElectricalComponent(item))
                    continue;

                double maxCurrent = 0;

                // For Busbar Chamber, calculate total outgoing load current
                if (item.Name.Contains("Busbar Chamber"))
                {
                    var outgoingConnectors = allConnectors.Where(c => c.SourceItem == item).ToList();
                    foreach (var connector in outgoingConnectors)
                    {
                        if (connector.CurrentValues != null)
                        {
                            double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                            double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                            double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));
                            double connectorMaxCurrent = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                            maxCurrent += connectorMaxCurrent;
                        }
                    }
                }
                // For distribution boards (VTPN, HTPN, SPN DB), calculate total incoming current
                if (item.Name.Contains("VTPN") || item.Name.Contains("HTPN") || item.Name.Contains("SPN DB"))
                {
                    // Get incoming connectors (where this item is the target)
                    var incomingConnectors = allConnectors.Where(c => c.TargetItem == item).ToList();
                    
                    foreach (var connector in incomingConnectors)
                    {
                        if (connector.CurrentValues != null)
                        {
                            // Get maximum current from all phases
                            double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                            double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                            double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));

                            double connectorMaxCurrent = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                            maxCurrent = Math.Max(maxCurrent, connectorMaxCurrent);
                        }
                    }
                }
                else
                {
                    // For other components (Main Switch, Change Over Switch), use all connected connectors
                    var connectedConnectors = allConnectors.Where(c => 
                        c.SourceItem == item || c.TargetItem == item).ToList();

                    foreach (var connector in connectedConnectors)
                    {
                        if (connector.CurrentValues != null)
                        {
                            // Get maximum current from all phases
                            double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                            double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                            double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));

                            double connectorMaxCurrent = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                            maxCurrent = Math.Max(maxCurrent, connectorMaxCurrent);
                        }
                    }
                }

                maxCurrentPerItem[item] = maxCurrent;
                Console.WriteLine($"Component {item.Name}: Max Current = {maxCurrent:F2} A");
            }
        }

        /// <summary>
        /// Apply downstream-to-upstream rating logic
        /// </summary>
        private void ApplyDownstreamToUpstreamRating()
        {
            // Process components in order: loads -> switches -> distribution boards -> main switches
            var processOrder = new[]
            {
                new[] { "Load" }, // Loads first (though they don't need rating updates)
                new[] { "MCB", "MCCB", "Switch" }, // Individual switches
                new[] { "Busbar Chamber" }, // Busbar Chamber
                new[] { "SPN DB", "HTPN" }, // Distribution boards
                new[] { "VTPN", "Cubical Panel" }, // Main distribution panels
                new[] { "Main Switch", "Change Over Switch" } // Main switches
            };

            foreach (var componentGroup in processOrder)
            {
                var componentsToProcess = allItems.Where(item => 
                    componentGroup.Any(type => item.Name != null && item.Name.Contains(type))).ToList();

                foreach (var component in componentsToProcess)
                {
                    SetOptimalRating(component);
                }
            }
        }

        /// <summary>
        /// Set optimal rating for a specific component
        /// </summary>
        private void SetOptimalRating(CanvasItem component)
        {
            // For Cubical Panel, we calculate current internally per section, so we don't strictly require maxCurrentPerItem
            if (!component.Name.Contains("Cubical Panel") && !maxCurrentPerItem.ContainsKey(component))
                return;

            double requiredCurrent = maxCurrentPerItem.ContainsKey(component) ? maxCurrentPerItem[component] : 0;
            
            // For distribution boards, use the actual incoming current
            // For main switches and change over switches, consider downstream requirements
            double totalRequiredCurrent = requiredCurrent;
            
            if (component.Name != null && (component.Name.Contains("Main Switch") || component.Name.Contains("Change Over Switch")))
            {
                // For main switches, also consider downstream load requirement
                double downstreamCurrent = CalculateDownstreamCurrent(component);
                totalRequiredCurrent = Math.Max(requiredCurrent, downstreamCurrent);
            }
            
            // Get safety margin from user settings (percentage value)
            double safetyMarginPercentage = ApplicationSettings.Instance.SafetyMarginPercentage;
            double safetyMargin = 1 + (safetyMarginPercentage / 100);
            double minimumRating = totalRequiredCurrent * safetyMargin;

            try
            {
                if (component.Name.Contains("VTPN"))
                {
                    SetVTPNRating(component, minimumRating);
                }
                else if (component.Name.Contains("Cubical Panel"))
                {
                    SetCubicalPanelRating(component, safetyMargin);
                }
                else if (component.Name.Contains("Busbar Chamber"))
                {
                    SetBusbarChamberRating(component, minimumRating);
                }
                else if (component.Name.Contains("HTPN"))
                {
                    SetHTPNRating(component, minimumRating);
                }
                else if (component.Name.Contains("SPN DB"))
                {
                    SetSPNDBRating(component, minimumRating);
                }
                else if (component.Name.Contains("Main Switch"))
                {
                    SetMainSwitchRating(component, minimumRating);
                }
                else if (component.Name.Contains("Change Over Switch"))
                {
                    SetChangeOverSwitchRating(component, minimumRating);
                }

                if (component.Name.Contains("Main Switch") || component.Name.Contains("Change Over Switch"))
                {
                    double downstreamCurrent = CalculateDownstreamCurrent(component);
                    Console.WriteLine($"Set rating for {component.Name}: Required {minimumRating:F2} A (Current: {requiredCurrent:F2} A, Downstream: {downstreamCurrent:F2} A)");
                }
                else if (!component.Name.Contains("Cubical Panel"))
                {
                    Console.WriteLine($"Set rating for {component.Name}: Required {minimumRating:F2} A (Current: {requiredCurrent:F2} A)");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error setting rating for {component.Name}: {ex.Message}");
            }
        }

        // ... existing CalculateDownstreamCurrent ...

        /// <summary>
        /// Set Cubical Panel rating (Per Incomer/Section)
        /// </summary>
        /// <summary>
        /// Set Cubical Panel rating (Per Incomer/Section)
        /// Handles Change Over Switch logic where two incomers share the load of two sections.
        /// </summary>
        private void SetCubicalPanelRating(CanvasItem panel, double safetyMargin)
        {
            if (panel.Properties == null || !panel.Properties.Any())
                return;

            var properties = panel.Properties.First();

            // 1. Determine number of Sections/Incomers
            int incomerCount = 1; 
            if (properties.ContainsKey("Incomer Count"))
            {
               int.TryParse(properties["Incomer Count"], out incomerCount);
            }
            else
            {
                while (properties.ContainsKey($"Incomer{incomerCount + 1}_Type")) incomerCount++;
            }

            Console.WriteLine($"Auto-Rating Cubical Panel: {incomerCount} Sections");

            // 2. Loop through sections
            for (int i = 1; i <= incomerCount; i++)
            {
                // Check for Change Over Switch coupling with next section
                bool isChangeOverNext = i < incomerCount && 
                                      (properties.GetValueOrDefault($"BusCoupler{i}_Type", "") == "Change Over Switch Open" ||
                                       properties.GetValueOrDefault($"BusCoupler{i}_Type", "") == "Change Over Switch");

                if (isChangeOverNext)
                {
                    // --- Change Over Switch Logic (Sec i and Sec i+1) ---
                    double load1 = CalculateCubicalSectionLoad(panel, i);
                    double load2 = CalculateCubicalSectionLoad(panel, i + 1);
                    double combinedLoad = load1 + load2;
                    double requiredRating = combinedLoad * safetyMargin;

                    Console.WriteLine($"  Change Over Detected (Sec {i} & {i+1}): Total Load {combinedLoad:F2} A -> Req {requiredRating:F2} A");

                    // Rate Incomer i
                    RateCubicalIncomer(properties, i, requiredRating);
                    
                    // Rate Incomer i+1
                    RateCubicalIncomer(properties, i + 1, requiredRating);

                    // Rate the Change Over Switch Coupler
                    RateChangeOverSwitch(properties, i, requiredRating);

                    // Skip next section as we handled it
                    i++;
                }
                else
                {
                    // --- Normal Logic (Section i) ---
                    double sectionLoad = CalculateCubicalSectionLoad(panel, i);
                    double requiredRating = sectionLoad * safetyMargin;
                    
                    Console.WriteLine($"  Section {i} Load: {sectionLoad:F2} A -> Req: {requiredRating:F2} A");

                    // Rate Incomer i
                    RateCubicalIncomer(properties, i, requiredRating);
                    
                    // Note: Standard Bus Couplers are typically rated for the bus bar capacity or manually set.
                    // If auto-rating is needed for standard couplers, it would go here.
                    // For now, we only auto-rate the specific requested Change Over Switch.
                }
            }

            // 3. Set Outgoing Ratings
            SetCubicalPanelOutgoingRatings(panel);
        }

        private double CalculateCubicalSectionLoad(CanvasItem panel, int sectionIndex)
        {
            double sectionLoad = 0;
            if (panel.Outgoing != null)
            {
                for (int outIdx = 0; outIdx < panel.Outgoing.Count; outIdx++)
                {
                    var outProp = panel.Outgoing[outIdx];
                    bool inSection = false;
                    if (outProp.ContainsKey("Section"))
                    {
                         if (int.TryParse(outProp["Section"], out int s) && s == sectionIndex) inSection = true;
                    }
                    else if (sectionIndex == 1) inSection = true; // Default to section 1

                    if (inSection)
                    {
                        string sourcePointKey = $"out{outIdx + 1}";
                        var connector = allConnectors.FirstOrDefault(c => c.SourceItem == panel && c.SourcePointKey == sourcePointKey);
                        
                        if (connector != null && connector.CurrentValues != null)
                        {
                            double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                            double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                            double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));
                            double maxC = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                            sectionLoad += maxC;
                        }
                    }
                }
            }
            return sectionLoad;
        }

        private void RateCubicalIncomer(Dictionary<string, string> properties, int index, double requiredRating)
        {
            string prefix = $"Incomer{index}_";
            string incomerType = properties.GetValueOrDefault($"{prefix}Type", "MCCB");
            string company = properties.GetValueOrDefault($"{prefix}Company", "");
            string pole = properties.GetValueOrDefault($"{prefix}Pole", "");

            if (string.IsNullOrEmpty(incomerType)) incomerType = "MCCB";

            // Load database options
            string dbType = incomerType;
            if (incomerType == "Change Over Switch Open") dbType = "Change Over Switch Open"; // Explicit check just in case

            var dbResult = DatabaseLoader.LoadDefaultPropertiesFromDatabase(dbType, 2);
            var options = dbResult.Properties
                .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase))
                .ToList();

            bool isSfu = incomerType.Contains("Main Switch") || incomerType.Contains("SFU");
            if (!isSfu && !string.IsNullOrEmpty(pole))
            {
                 options = options.Where(row => row.ContainsKey("Pole") && row["Pole"]?.ToString() == pole).ToList();
            }

            options = options.OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue).ToList();

            var selected = SelectOptimalRating(options, requiredRating, incomerType);

            if (selected != null)
            {
                properties[$"{prefix}Rating"] = selected["Current Rating"];
                if (selected.ContainsKey("Rate")) properties[$"{prefix}Rate"] = selected["Rate"];
                if (selected.ContainsKey("Description")) properties[$"{prefix}Description"] = selected["Description"];
                if (selected.ContainsKey("GS")) properties[$"{prefix}GS"] = selected["GS"];
                
                Console.WriteLine($"  -> Incomer {index} Selected {incomerType}: {selected["Current Rating"]}");
            }
            else
            {
                Console.WriteLine($"  -> Warning: No suitable {incomerType} found for {requiredRating}A.");
            }
        }

        private void RateChangeOverSwitch(Dictionary<string, string> properties, int couplerIndex, double requiredRating)
        {
            string prefix = $"BusCoupler{couplerIndex}_";
            string type = "Change Over Switch Open"; // Force this type for search
            // Company might not be set for coupler specifically? Use Incomer 1 company or default?
            // Usually couplers pick up the panel make or have their own property.
            // Let's assume we search for ALL companies if not specified, or use Incomer1 company as fallback.
            string company = properties.GetValueOrDefault($"Incomer{couplerIndex}_Company", ""); 

            var dbResult = DatabaseLoader.LoadDefaultPropertiesFromDatabase(type, 2);
            var options = dbResult.Properties
                .Where(row => string.IsNullOrEmpty(company) || string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase))
                .ToList();

            options = options.OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue).ToList();

            var selected = SelectOptimalRating(options, requiredRating, type);

            if (selected != null)
            {
                properties[$"{prefix}Rating"] = selected["Current Rating"];
                // Also set other props onto the coupler config if we want BOM to pick it up
                // The PanelRenderer uses `BusCoupler{sec}_Rating` so this is correct.
                Console.WriteLine($"  -> Coupler {couplerIndex} Selected {type}: {selected["Current Rating"]}");
            }
            else
            {
                Console.WriteLine($"  -> Warning: No suitable {type} found for {requiredRating}A.");
            }
        }

        private void SetCubicalPanelOutgoingRatings(CanvasItem panel)
        {
            if (panel.Outgoing == null) return;

            for (int i = 0; i < panel.Outgoing.Count; i++)
            {
                var outProp = panel.Outgoing[i];
                
                // Get configured Company from the item itself (since it's per-device now)
                string company = outProp.GetValueOrDefault("Company", "");

                // Check load for this circuit
                string sourcePointKey = $"out{i + 1}";
                var connector = allConnectors.FirstOrDefault(c => c.SourceItem == panel && c.SourcePointKey == sourcePointKey);
                
                double load = 0;
                if (connector != null && connector.CurrentValues != null)
                {
                    double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                    double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                    double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));
                    load = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                }

                // If load is 0, we might still want to set a default minimum if the user just added it?
                // But generally auto-rating responds to load.
                if (load > 0)
                {
                    double req = load * 1.25; // 25% margin for outgoing
                    string type = outProp.GetValueOrDefault("Type", "MCB"); 
                    if (string.IsNullOrEmpty(type)) type = "MCB";
                    
                    string pole = outProp.GetValueOrDefault("Pole", "");

                    // Load DB options
                    var dbResult = DatabaseLoader.LoadDefaultPropertiesFromDatabase(type, 2);
                    var options = dbResult.Properties
                        .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase))
                        .ToList();

                    // Filter by Pole if applicable
                    // Main Switch Open typically implies TPN, check logic
                    bool isSfu = type == "Main Switch Open";
                    if (!isSfu && !string.IsNullOrEmpty(pole))
                    {
                         options = options.Where(row => row.ContainsKey("Pole") && row["Pole"]?.ToString() == pole).ToList();
                    }
                    
                    options = options.OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue).ToList();

                    var selected = SelectOptimalRating(options, req, type);
                    if (selected != null)
                    {
                        outProp["Current Rating"] = selected["Current Rating"];
                        if (selected.ContainsKey("Rate")) outProp["Rate"] = selected["Rate"];
                        if (selected.ContainsKey("Description")) outProp["Description"] = selected["Description"];
                        if (selected.ContainsKey("GS")) outProp["GS"] = selected["GS"];
                        
                        Console.WriteLine($"  -> Outgoing {i+1} ({type}): {selected["Current Rating"]}");
                    }
                }
            }
        }

        /// <summary>
        /// Calculate the total downstream current requirement for upstream components
        /// </summary>
        private double CalculateDownstreamCurrent(CanvasItem component)
        {
            double totalDownstreamCurrent = 0;

            // Get all outgoing connectors from this component
            var outgoingConnectors = allConnectors.Where(c => c.SourceItem == component).ToList();

            foreach (var connector in outgoingConnectors)
            {
                if (connector.TargetItem != null && connector.CurrentValues != null)
                {
                    // Always use the actual current flowing through the connector
                    double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                    double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                    double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));
                    double connectorCurrent = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                    totalDownstreamCurrent += connectorCurrent;
                }
            }

            return totalDownstreamCurrent;
        }

        /// <summary>
        /// Set VTPN rating (uses MCCB for incomer, MCB for outgoing)
        /// </summary>
        private void SetVTPNRating(CanvasItem vtpn, double minimumRating)
        {
            if (vtpn.Properties == null || !vtpn.Properties.Any())
                return;

            var properties = vtpn.Properties.First();
            string company = properties.GetValueOrDefault("Company", "");

            // --- Step 1: Auto-Rate the VTPN Board itself ---

            // Calculate required ways (Outgoing circuits)
            int maxOutIndex = 0;
            var outConnectors = allConnectors.Where(c => c.SourceItem == vtpn).ToList();
            foreach (var conn in outConnectors)
            {
                int idx = GetOutgoingIndexFromPointKey(conn.SourcePointKey, "VTPN"); // VTPN name contains "VTPN"
                if (idx + 1 > maxOutIndex) maxOutIndex = idx + 1;
            }
            int requiredWays = maxOutIndex; // e.g., if out12 is used, we need at least 12 ways? 
                                            // The DB says "4 way", "8 way". Usually this means TPN ways. 
                                            // Assuming "outX" maps to one way.

            // Load VTPN Board options
            var vtpnOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("VTPN", 2).Properties
                .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase))
                .ToList();

            Dictionary<string, string> selectedBoard = null;

            if (vtpnOptions.Any())
            {
                // Filter options that meet both Current and Way requirements
                var validBoards = vtpnOptions.Where(row =>
                {
                    double rating = ParseRating(row["Current Rating"]?.ToString()); // Handles "Up to 100A" -> 100
                    int ways = ParseWays(row["Way"]?.ToString());

                    return rating >= minimumRating && ways >= requiredWays;
                })
                .OrderBy(row => ParseRating(row["Current Rating"]?.ToString())) // Prefer smallest sufficient rating
                .ThenBy(row => ParseWays(row["Way"]?.ToString()))               // Then smallest sufficient ways
                .ToList();

                selectedBoard = validBoards.FirstOrDefault();

                if (selectedBoard != null)
                {
                    // Update VTPN Properties
                    properties["Current Rating"] = selectedBoard["Current Rating"]; // e.g., "Up to 100A"
                    properties["Way"] = selectedBoard["Way"];
                    if (selectedBoard.ContainsKey("Rate")) properties["Rate"] = selectedBoard["Rate"];
                    if (selectedBoard.ContainsKey("Description")) properties["Description"] = selectedBoard["Description"];
                    if (selectedBoard.ContainsKey("GS")) properties["GS"] = selectedBoard["GS"];
                    
                    Console.WriteLine($"VTPN Board: Selected {selectedBoard["Current Rating"]} ({selectedBoard["Way"]}) for {minimumRating:F2}A load and {requiredWays} ways.");
                }
                else
                {
                     // Fallback: Pick highest available if nothing fits (or just warn)
                     Console.WriteLine($"Warning: No suitable VTPN board found for {minimumRating:F2}A and {requiredWays} ways.");
                }
            }

            // --- Step 2: Rate Incomer (MCCB) ---
            
            // Determine VTPN Board Rating (Upper Limit) from the newly set property
            double boardRating = ParseRating(properties.GetValueOrDefault("Current Rating", "0"));

            // Set incomer rating (MCCB)
            var mccbOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("MCCB", 2).Properties
                .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase))
                .OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue)
                .ToList();

            // Filter options based on user requirements:
            // 1. Rating >= 63 A
            // 2. Rating <= Board Rating (if known)
            var validOptions = mccbOptions.Where(option => 
            {
                double r = ParseRating(option["Current Rating"]?.ToString());
                bool lowerBound = r >= 63;
                bool upperBound = boardRating <= 0 || r <= boardRating;
                return lowerBound && upperBound;
            }).ToList();

            // Use the filtered list for selection
            // If minimumRating is < 63, the filter handles it (we won't pick < 63).
            // If minimumRating > boardRating, validOptions might be empty.
            var selectedMCCB = SelectOptimalRating(validOptions, minimumRating, "MCCB");

            if (selectedMCCB != null)
            {
                properties["IncomerCurrentRating"] = selectedMCCB["Current Rating"]; // Storing separately if needed or just updating Incomer dict
                // Ideally Incomer dictionary is what matters for the BOM/report
                // Update rate from Excel database
                if (selectedMCCB.ContainsKey("Rate"))
                {
                    properties["Rate"] = selectedMCCB["Rate"];
                }
                vtpn.Incomer = new Dictionary<string, string>(selectedMCCB);
                Console.WriteLine($"VTPN Incomer: Selected {selectedMCCB["Current Rating"]} (Required: {minimumRating:F2} A)");
            }
            else
            {
                Console.WriteLine($"Warning: No suitable MCCB rating found for VTPN (Required: {minimumRating:F2} A)");
            }

            // Set outgoing ratings (MCB - TP)
            SetOutgoingRatings(vtpn, "MCB", "TP", company);
        }

        /// <summary>
        /// Set HTPN rating
        /// </summary>
        private void SetHTPNRating(CanvasItem htpn, double minimumRating)
        {
            if (htpn.Properties == null || !htpn.Properties.Any())
                return;

            var properties = htpn.Properties.First();
            string company = properties.GetValueOrDefault("Company", "");

            // Set incomer rating (MCB - FP)
            var mcbOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("MCB", 2).Properties
                .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase) &&
                             row["Pole"]?.ToString() == "FP")
                .OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue)
                .ToList();

            // Filter options for HTPN: 32A <= Rating <= 63A
            var validOptions = mcbOptions.Where(option => 
            {
                double r = ParseRating(option["Current Rating"]?.ToString());
                return r >= 32 && r <= 63;
            }).ToList();

            var selectedMCB = SelectOptimalRating(validOptions, minimumRating, "MCB (FP)");

            if (selectedMCB != null)
            {
                htpn.Incomer = new Dictionary<string, string>(selectedMCB);
                Console.WriteLine($"HTPN Incomer: Selected {selectedMCB["Current Rating"]} (Required: {minimumRating:F2} A)");
            }

            // Set outgoing ratings (MCB - SP)
            SetOutgoingRatings(htpn, "MCB", "SP", company);
        }

        /// <summary>
        /// Set SPN DB rating
        /// </summary>
        private void SetSPNDBRating(CanvasItem spndb, double minimumRating)
        {
            if (spndb.Properties == null || !spndb.Properties.Any())
                return;

            var properties = spndb.Properties.First();
            string company = properties.GetValueOrDefault("Company", "");

            // Set incomer rating (MCB Isolator - DP)
            var isolatorOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("MCB Isolator", 2).Properties
                .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase) &&
                             row["Pole"]?.ToString() == "DP")
                .OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue)
                .ToList();

            // Filter options for SPN DB: 25A <= Rating <= 40A
            var validOptions = isolatorOptions.Where(option => 
            {
                double r = ParseRating(option["Current Rating"]?.ToString());
                return r >= 25 && r <= 40;
            }).ToList();

            var selectedIsolator = SelectOptimalRating(validOptions, minimumRating, "MCB Isolator (DP)");

            if (selectedIsolator != null)
            {
                spndb.Incomer = new Dictionary<string, string>(selectedIsolator);
                Console.WriteLine($"SPN DB Incomer: Selected {selectedIsolator["Current Rating"]} (Required: {minimumRating:F2} A)");
            }

            // Set outgoing ratings (MCB - SP)
            SetOutgoingRatings(spndb, "MCB", "SP", company);
        }

        /// <summary>
        /// Set Main Switch rating
        /// </summary>
        private void SetMainSwitchRating(CanvasItem mainSwitch, double minimumRating)
        {
            if (mainSwitch.Properties == null || !mainSwitch.Properties.Any())
                return;

            var properties = mainSwitch.Properties.First();

            string deviceType = "Main Switch";

            var switchOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase(deviceType, 2).Properties
            .Where(row => 
            {
                var allColumns = row.Keys.ToList();
                var rateIndex = allColumns.IndexOf("Rate");
                var columnsToCheck = allColumns
                    .Take(rateIndex == -1 ? allColumns.Count : rateIndex)
                    .Where(key => key != "Current Rating");
                
                return columnsToCheck.All(column => 
                    row[column]?.ToString() == properties[column]?.ToString());
            }).OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue)
            .ToList();

            var selectedSwitch = SelectOptimalRating(switchOptions, minimumRating, deviceType);

            if (selectedSwitch != null)
                {
                    // Update all matching keys from selectedSwitch to properties
                    foreach (var key in selectedSwitch.Keys)
                    {
                        if (properties.ContainsKey(key))
                        {
                        properties[key] = selectedSwitch[key];
                    }
                    }
                    
                    Console.WriteLine($"Main Switch: Selected {selectedSwitch["Current Rating"]} (Required: {minimumRating:F2} A)");
                }
        }

        /// <summary>
        /// Set Change Over Switch rating
        /// </summary>
        private void SetChangeOverSwitchRating(CanvasItem changeOverSwitch, double minimumRating)
        {
            if (changeOverSwitch.Properties == null || !changeOverSwitch.Properties.Any())
                return;

            var properties = changeOverSwitch.Properties.First();

            string deviceType = "Change Over Switch";

            var switchOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase(deviceType, 2).Properties
                .Where(row => 
                {
                    var allColumns = row.Keys.ToList();
                    var rateIndex = allColumns.IndexOf("Rate");
                    var columnsToCheck = allColumns
                        .Take(rateIndex == -1 ? allColumns.Count : rateIndex)
                        .Where(key => key != "Current Rating");
                    
                    return columnsToCheck.All(column => 
                        row[column]?.ToString() == properties[column]?.ToString());
                })
                .OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue)
                .ToList();

            var selectedSwitch = SelectOptimalRating(switchOptions, minimumRating, deviceType);

            if (selectedSwitch != null)
                {
                    // Update all matching keys from selectedSwitch to properties
                    foreach (var key in selectedSwitch.Keys)
                    {
                        if (properties.ContainsKey(key))
                        {
                        properties[key] = selectedSwitch[key];
                    }
                    }
                Console.WriteLine($"Change Over Switch: Selected {selectedSwitch["Current Rating"]} (Required: {minimumRating:F2} A)");
            }
        }

        /// <summary>
        /// Set outgoing ratings for distribution boards
        /// </summary>
        private void SetOutgoingRatings(CanvasItem component, string deviceType, string poleType, string company)
        {
            if (component.Outgoing == null)
                component.Outgoing = new List<Dictionary<string, string>>();

            // Get available MCB options
            var mcbOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase(deviceType, 2).Properties
                .Where(row => string.Equals(row["Company"]?.ToString(), company, StringComparison.OrdinalIgnoreCase) &&
                              row["Pole"]?.ToString() == poleType)
                .OrderBy(row => int.TryParse(row["Current Rating"]?.ToString(), out var rating) ? rating : int.MaxValue)
                .ToList();

            // Get outgoing connectors to determine required ratings
            var outgoingConnectors = allConnectors.Where(c => c.SourceItem == component).ToList();
            
            Console.WriteLine($"Debug: {component.Name} has {outgoingConnectors.Count} outgoing connectors");

            // Process each connector and map it to the correct outgoing position
            foreach (var connector in outgoingConnectors)
            {
                // Determine the outgoing position index based on the SourcePointKey
                int outgoingIndex = GetOutgoingIndexFromPointKey(connector.SourcePointKey, component.Name);
                
                Console.WriteLine($"Debug: Connector {connector.SourcePointKey} -> Index {outgoingIndex}");
                
                if (outgoingIndex < 0)
                {
                    Console.WriteLine($"Warning: Could not determine outgoing index for {connector.SourcePointKey} in {component.Name}");
                    continue;
                }

                double requiredCurrent = 0;

                if (connector.CurrentValues != null)
                {
                    double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                    double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                    double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));
                    requiredCurrent = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));
                }

                // Only set rating if there is actual current flow (connected load)
                if (requiredCurrent > 0)
                {
                    // Add safety margin
                    double minimumRating = requiredCurrent * 1.25;

                    var selectedMCB = SelectOptimalRating(mcbOptions, minimumRating, deviceType);

                    if (selectedMCB != null)
                    {
                        // Ensure we have enough outgoing entries
                        while (component.Outgoing.Count <= outgoingIndex)
                        {
                            component.Outgoing.Add(new Dictionary<string, string>());
                        }

                        component.Outgoing[outgoingIndex] = new Dictionary<string, string>(selectedMCB);
                        Console.WriteLine($"{component.Name} {GetOutgoingDisplayName(connector.SourcePointKey)}: Selected {selectedMCB["Current Rating"]} (Required: {minimumRating:F2} A) at index {outgoingIndex}");
                        
                        // Verify it was set
                        if (component.Outgoing[outgoingIndex].ContainsKey("Current Rating"))
                        {
                             Console.WriteLine($"Debug: Verification - Outgoing[{outgoingIndex}][\"Current Rating\"] = {component.Outgoing[outgoingIndex]["Current Rating"]}");
                        }
                    }
                }
                else
                {
                    Console.WriteLine($"{component.Name} {GetOutgoingDisplayName(connector.SourcePointKey)}: No load connected, skipping rating update");
                }
            }
        }

        /// <summary>
        /// Check if an item is an electrical component that needs rating
        /// </summary>
        private bool IsElectricalComponent(CanvasItem item)
        {
            var electricalComponents = new[] { "VTPN", "HTPN", "SPN DB", "Busbar Chamber", "Main Switch", "Change Over Switch" };
            return electricalComponents.Any(type => item.Name.Contains(type));
        }

        /// <summary>
        /// Set Busbar Chamber rating based on total outgoing load current (with safety margin)
        /// and choose next available rating from database while keeping other configuration keys fixed.
        /// </summary>
        private void SetBusbarChamberRating(CanvasItem busbar, double minimumRating)
        {
            if (busbar.Properties == null || !busbar.Properties.Any())
                return;

            var properties = busbar.Properties.First();

            // Load available schedule rows
            var dbRows = DatabaseLoader.LoadDefaultPropertiesFromDatabase("Busbar Chamber", 2).Properties;
            if (dbRows == null || dbRows.Count == 0)
            {
                Console.WriteLine("Warning: No Busbar Chamber schedule rows found in database.");
                return;
            }

            // Determine which keys define the configuration (exclude rating and computed fields)
            var firstRow = dbRows.First();
            var configKeys = firstRow.Keys
                .Where(k => !string.Equals(k, "Current Rating", StringComparison.OrdinalIgnoreCase)
                         && !string.Equals(k, "Rate", StringComparison.OrdinalIgnoreCase)
                         && !string.Equals(k, "Description", StringComparison.OrdinalIgnoreCase)
                         && !string.Equals(k, "GS", StringComparison.OrdinalIgnoreCase))
                .ToList();

            // Filter rows by existing non-empty configuration fields on the item
            var candidates = dbRows.Where(row =>
            {
                foreach (var key in configKeys)
                {
                    if (properties.TryGetValue(key, out var val) && !string.IsNullOrWhiteSpace(val))
                    {
                        if (!row.TryGetValue(key, out var rowVal)) return false;
                        if (!string.Equals(rowVal?.ToString() ?? string.Empty, val, StringComparison.Ordinal)) return false;
                    }
                }
                return true;
            }).ToList();

            if (candidates.Count == 0)
            {
                // Fallback to all rows if config-based filtering yields nothing
                Console.WriteLine("Warning: No Busbar Chamber rows matched current configuration; falling back to all options.");
                candidates = dbRows;
            }

            candidates = candidates
                .OrderBy(r => ParseRating(r.GetValueOrDefault("Current Rating", "0")?.ToString()))
                .ToList();

            var selected = SelectOptimalRating(candidates, minimumRating, "Busbar Chamber");
            if (selected == null)
            {
                Console.WriteLine($"Warning: No suitable Busbar Chamber rating found for {minimumRating:F2} A");
                return;
            }

            // Update only rating-dependent fields, keeping other configuration keys intact
            if (selected.ContainsKey("Current Rating")) properties["Current Rating"] = selected["Current Rating"];
            if (selected.ContainsKey("Rate")) properties["Rate"] = selected["Rate"];
            if (selected.ContainsKey("Description")) properties["Description"] = selected["Description"];
            if (selected.ContainsKey("GS")) properties["GS"] = selected["GS"];

            Console.WriteLine($"Busbar Chamber: Selected {properties.GetValueOrDefault("Current Rating", "") } for required {minimumRating:F2} A");
        }

        /// <summary>
        /// Parse current value from string (e.g., "10.5 A" -> 10.5)
        /// </summary>
        private double ParseCurrent(string currentStr)
        {
            if (string.IsNullOrEmpty(currentStr))
                return 0;

            var match = Regex.Match(currentStr, @"(\d+\.?\d*)");
            if (match.Success && double.TryParse(match.Value, out double current))
            {
                return current;
            }
            return 0;
        }

        /// <summary>
        /// Parse rating value from string (e.g., "63 A" -> 63)
        /// </summary>
        private double ParseRating(string ratingStr)
        {
            if (string.IsNullOrEmpty(ratingStr))
                return 0;

            var match = Regex.Match(ratingStr, @"(\d+\.?\d*)");
            if (match.Success && double.TryParse(match.Value, out double rating))
            {
                return rating;
            }
            return 0;
        }

        /// <summary>
        /// Parse ways from string (e.g., "4 way" -> 4)
        /// </summary>
        private int ParseWays(string waysStr)
        {
            if (string.IsNullOrEmpty(waysStr))
                return 0;

            var match = Regex.Match(waysStr, @"(\d+)");
            if (match.Success && int.TryParse(match.Value, out int ways))
            {
                return ways;
            }
            return 0;
        }

        /// <summary>
        /// Select optimal rating from available options ensuring it's greater than minimum required
        /// </summary>
        private Dictionary<string, string> SelectOptimalRating(List<Dictionary<string, string>> options, double minimumRating, string deviceType)
        {
            if (options == null || !options.Any())
            {
                Console.WriteLine($"Warning: No {deviceType} options available");
                return null;
            }

            // Filter options that meet the minimum rating requirement
            var suitableOptions = options.Where(option => 
                ParseRating(option["Current Rating"]?.ToString()) >= minimumRating).ToList();

            if (!suitableOptions.Any())
            {
                Console.WriteLine($"Warning: No {deviceType} ratings meet minimum requirement of {minimumRating:F2} A");
                // Return the highest available rating as fallback
                var highestOption = options.OrderByDescending(option => 
                    ParseRating(option["Current Rating"]?.ToString())).FirstOrDefault();
                if (highestOption != null)
                {
                    Console.WriteLine($"Fallback: Using highest available {deviceType} rating: {highestOption["Current Rating"]}");
                }
                return highestOption;
            }

            // Select the lowest rating that meets the requirement (most economical choice)
            var selectedOption = suitableOptions.OrderBy(option => 
                ParseRating(option["Current Rating"]?.ToString())).FirstOrDefault();

            return selectedOption;
        }

        /// <summary>
        /// Get the outgoing index from the connection point key
        /// </summary>
        private int GetOutgoingIndexFromPointKey(string pointKey, string componentName)
        {
            if (string.IsNullOrEmpty(pointKey))
                return -1;

            if (componentName.Contains("HTPN"))
            {
                // HTPN format: "out{i}_{phase}" where phase is "Red Phase", "Yellow Phase", "Blue Phase"
                var match = Regex.Match(pointKey, @"out(\d+)_(.+)\s+Phase");
                if (match.Success)
                {
                    int number = int.Parse(match.Groups[1].Value);
                    string phase = match.Groups[2].Value;
                    
                    // Calculate the index based on phase and number
                    int phaseOffset = 0;
                    if (phase == "Yellow") phaseOffset = 1;
                    else if (phase == "Blue") phaseOffset = 2;
                    
                    int outgoingsPerPhase = 4; // This might need to be dynamic
                    
                    return (phaseOffset * outgoingsPerPhase) + (number - 1);
                }
            }
            else if (componentName.Contains("VTPN") || componentName.Contains("SPN DB"))
            {
                // VTPN/SPN DB format: "out{i}"
                var match = Regex.Match(pointKey, @"out(\d+)");
                if (match.Success)
                {
                    return int.Parse(match.Groups[1].Value) - 1; // Convert to 0-based index
                }
            }

            return -1;
        }

        /// <summary>
        /// Get a display name for the outgoing connection point
        /// </summary>
        private string GetOutgoingDisplayName(string pointKey)
        {
            if (string.IsNullOrEmpty(pointKey))
                return "Unknown";

            // For HTPN: "out1_Red Phase" -> "R1"
            var htpnMatch = Regex.Match(pointKey, @"out(\d+)_(.+)\s+Phase");
            if (htpnMatch.Success)
            {
                int number = int.Parse(htpnMatch.Groups[1].Value);
                string phase = htpnMatch.Groups[2].Value;
                string phaseShort = phase.Substring(0, 1); // R, Y, B
                return $"{phaseShort}{number}";
            }

            // For VTPN/SPN DB: "out1" -> "Outgoing 1"
            var vtpnMatch = Regex.Match(pointKey, @"out(\d+)");
            if (vtpnMatch.Success)
            {
                return $"Outgoing {vtpnMatch.Groups[1].Value}";
            }

            return pointKey;
        }

        /// <summary>
        /// Set cable and wire ratings intelligently
        /// </summary>
        private void SetCableAndWireRatings()
        {
            if (cableCapacityTables == null || cableCapacityTables.Count == 0)
            {
                LogProcess("Warning: Cable capacity tables not loaded.");
            }
            
            if (wireCapacityTable == null || wireCapacityTable.Count == 0)
            {
                LogProcess("Warning: Wire capacity table not loaded.");
            }

            int cablesRated = 0;
            int wiresRated = 0;
            int connectionsSkipped = 0;

            foreach (var connector in allConnectors)
            {
                // Skip if no properties set (not a cable/wire)
                if (connector.Properties == null || !connector.Properties.Any())
                {
                    // LogProcess($"Connector {GetConnectorName(connector)}: No properties set, skipping");
                    connectionsSkipped++;
                    continue;
                }

                // Skip cables connected to fixed-spec switch boards (Point SB, Avg 5A SB)
                if ((connector.TargetItem != null && (connector.TargetItem.Name == "Point Switch Board" || connector.TargetItem.Name == "Avg. 5A Switch Board")) ||
                    (connector.SourceItem != null && (connector.SourceItem.Name == "Point Switch Board" || connector.SourceItem.Name == "Avg. 5A Switch Board")))
                {
                    LogProcess($"Connector {GetConnectorName(connector)}: Connected to fixed-spec board, skipping auto-rating");
                    connectionsSkipped++;
                    continue;
                }

                // Skip if no current values
                if (connector.CurrentValues == null || !connector.CurrentValues.Any())
                {
                    // LogProcess($"Connector {GetConnectorName(connector)}: No current values, skipping");
                    connectionsSkipped++;
                    continue;
                }

                // Calculate maximum current across all phases
                double rCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("R_Current", "0 A"));
                double yCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("Y_Current", "0 A"));
                double bCurrent = ParseCurrent(connector.CurrentValues.GetValueOrDefault("B_Current", "0 A"));
                double maxCurrent = Math.Max(rCurrent, Math.Max(yCurrent, bCurrent));

                if (maxCurrent <= 0)
                {
                    LogProcess($"Connector {GetConnectorName(connector)}: No current flow, skipping rating");
                    connectionsSkipped++;
                    continue;
                }

                // Determine connection type based on properties
                bool isWireConnection = connector.Properties.ContainsKey("Conductor Size");
                bool isCableConnection = connector.Properties.ContainsKey("Conductor") && 
                                       connector.Properties.ContainsKey("Core") && 
                                       connector.Properties.ContainsKey("Size");

                // Calculate required current based on downstream rating or load + safety margin
                double safetyMarginPercentage = ApplicationSettings.Instance.SafetyMarginPercentage;
                double safetyMargin = 1 + (safetyMarginPercentage / 100);
                double requiredRating = maxCurrent * safetyMargin;

                double? downstreamRating = GetDownstreamRatedCurrent(connector);
                if (downstreamRating.HasValue && downstreamRating.Value > 0)
                {
                    requiredRating = Math.Max(requiredRating, downstreamRating.Value);
                    // LogProcess($"Connector {GetConnectorName(connector)}: Using Max(Load, Downstream) = {requiredRating:F2} A");
                }

                bool rated = false;
                string type = "Unknown";

                if (isWireConnection && !isCableConnection)
                {
                    type = "Wire";
                    rated = SetSingleWireRating(connector, maxCurrent, requiredRating);
                    if (rated) wiresRated++;
                }
                else if (isCableConnection && !isWireConnection)
                {
                    type = "Cable";
                    rated = SetSingleCableRating(connector, maxCurrent, requiredRating);
                    if (rated) cablesRated++;
                }
                else if (isWireConnection && isCableConnection)
                {
                    // Both properties exist - this shouldn't happen, but prioritize based on MaterialType
                    LogProcess($"Connector {GetConnectorName(connector)}: Has both wire and cable properties, using MaterialType: {connector.MaterialType}");
                    
                    if (connector.MaterialType == "Wiring")
                    {
                        type = "Wire";
                        rated = SetSingleWireRating(connector, maxCurrent, requiredRating);
                        if (rated) wiresRated++;
                    }
                    else // Default to cable
                    {
                        type = "Cable";
                        rated = SetSingleCableRating(connector, maxCurrent, requiredRating);
                        if (rated) cablesRated++;
                    }
                }
                else
                {
                    LogProcess($"Connector {GetConnectorName(connector)}: Cannot determine connection type, skipping");
                    connectionsSkipped++;
                    continue;
                }

                if (rated)
                {
                    string size = type == "Wire" ? connector.Properties["Conductor Size"] : connector.Properties["Size"];
                    string downstreamInfo = downstreamRating.HasValue ? $" (Device Rated: {downstreamRating.Value:F1} A)" : "";
                    LogProcess($"{type} {GetConnectorName(connector)}: Rated for {requiredRating:F2} A{downstreamInfo} -> Selected {size}");
                }
                else
                {
                    LogProcess($"{type} {GetConnectorName(connector)}: Failed to rate for {requiredRating:F2} A");
                    connectionsSkipped++;
                }
            }

            LogProcess($"Auto-rating complete: {cablesRated} cables rated, {wiresRated} wires rated, {connectionsSkipped} skipped");
        }

        /// <summary>
        /// Get the rated current of the downstream device or its incomer
        /// </summary>
        private double? GetDownstreamRatedCurrent(Connector connector)
        {
            var target = connector.TargetItem;
            if (target == null) return null;

            // 1. VTPN, HTPN, SPN DB -> Incomer["Current Rating"]
            if (target.Name.Contains("VTPN") || target.Name.Contains("HTPN") || target.Name.Contains("SPN DB"))
            {
                if (target.Incomer != null && target.Incomer.TryGetValue("Current Rating", out string ratingStr))
                {
                    return ParseRating(ratingStr);
                }
            }

            // 2. Main Switch, Change Over Switch, Bus Coupler -> Properties["Current Rating"]
            if (target.Name.Contains("Main Switch") || target.Name.Contains("Change Over Switch") || target.Name.Contains("Bus Coupler"))
            {
                if (target.Properties != null && target.Properties.Any())
                {
                    var props = target.Properties.First();
                    if (props.TryGetValue("Current Rating", out string ratingStr))
                    {
                        return ParseRating(ratingStr);
                    }
                }
            }

            // 3. Cubical Panel -> Specific Incomer Rating based on connection point
            if (target.Name.Contains("Cubical Panel"))
            {
                var props = target.Properties?.FirstOrDefault();
                if (props != null && !string.IsNullOrEmpty(connector.TargetPointKey))
                {
                    // Extract number from "inX" (e.g. in1, in2)
                    var match = Regex.Match(connector.TargetPointKey, @"in(\d+)");
                    if (match.Success)
                    {
                        string index = match.Groups[1].Value;
                        string key = $"Incomer{index}_Rating";
                        if (props.TryGetValue(key, out string ratingStr))
                        {
                            return ParseRating(ratingStr);
                        }
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// Set rating for a single cable connection
        /// </summary>
        private bool SetSingleCableRating(Connector connector, double maxCurrent, double requiredCurrent)
        {
            if (cableCapacityTables == null || cableCapacityTables.Count == 0)
            {
                Console.WriteLine($"Cable {GetConnectorName(connector)}: Cable capacity tables not available");
                return false;
            }

            // Get conductor type
            if (!connector.Properties.ContainsKey("Conductor"))
            {
                Console.WriteLine($"Cable {GetConnectorName(connector)}: No conductor type specified");
                return false;
            }
            string conductor = connector.Properties["Conductor"];

            // Get core type
            if (!connector.Properties.ContainsKey("Core"))
            {
                Console.WriteLine($"Cable {GetConnectorName(connector)}: No core type specified");
                return false;
            }
            string coreRaw = connector.Properties["Core"];
            string coreCategory = MapCoreType(coreRaw);

            // Find minimum cable size considering both current capacity and voltage drop
            var result = FindMinimumCableSizeWithVoltageDrop(conductor, coreCategory, requiredCurrent, connector, maxCurrent);
            if (result.size <= 0)
            {
                Console.WriteLine($"Cable {GetConnectorName(connector)}: No suitable cable size found for {conductor} {coreCategory} (Required: {requiredCurrent:F1} A)");
                return false;
            }

            // Try to update from database
            try
            {
                var cableOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("Cable", 2).Properties
                    .Where(row => 
                        {
                            var allColumns = row.Keys.ToList();
                            var rateIndex = allColumns.IndexOf("Rate");
                            var columnsToCheck = allColumns
                                .Take(rateIndex == -1 ? allColumns.Count : rateIndex)
                                .Where(key => key != "Size");
                            
                            return columnsToCheck.All(column => 
                                row[column]?.ToString() == connector.Properties[column]?.ToString());
                        })
                    .OrderBy(row => int.TryParse(row["Size"]?.ToString(), out var Size) ? Size : int.MaxValue)
                    .ToList();

                if (cableOptions.Any())
                {
                    var suitableCables = cableOptions.Where(option => 
                    {
                        var sizeMatch = Regex.Match(option["Size"]?.ToString() ?? "", @"\d+");
                        return sizeMatch.Success && int.TryParse(sizeMatch.Value, out var size) && size >= result.size;
                    }).ToList();
                        
                    if (!suitableCables.Any())
                    {
                        // Fallback to largest
                        var selectedCable = cableOptions.OrderByDescending(option => 
                        {
                            var sizeMatch = Regex.Match(option["Size"]?.ToString() ?? "", @"\d+");
                            return sizeMatch.Success && int.TryParse(sizeMatch.Value, out var size) ? size : int.MinValue;
                        }).First();
                        
                        foreach (var key in selectedCable.Keys)
                        {
                            if (connector.Properties.ContainsKey(key))
                            {
                                connector.Properties[key] = selectedCable[key];
                            }
                        }
                    }
                    else
                    {
                        var selectedCable = suitableCables.OrderBy(option => 
                        {
                            var sizeMatch = Regex.Match(option["Size"]?.ToString() ?? "", @"\d+");
                            return sizeMatch.Success && int.TryParse(sizeMatch.Value, out var size) ? size : int.MaxValue;
                        }).First();
                        
                        foreach (var key in selectedCable.Keys)
                        {
                            if (connector.Properties.ContainsKey(key))
                            {
                                connector.Properties[key] = selectedCable[key];
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Warning: Could not update cable rate from database: {ex.Message}");
            }

            string warningMsg = result.isOverflow ? " [WARNING: Using maximum available size]" : "";
            string voltageDropMsg = ApplicationSettings.Instance.VoltageDropEnabled && connector.Length > 0 
                ? $" [VDrop: {VoltageDropCalculator.CalculateCableVoltageDrop(conductor, coreCategory, result.size, maxCurrent, connector.Length):F3}V]" 
                : "";
            Console.WriteLine($"Cable {GetConnectorName(connector)}: Selected {result.size} sq.mm (Required: {requiredCurrent:F1} A, Rated: {result.ratedCurrent} A){voltageDropMsg}{warningMsg}");
            return true;
        }

        /// <summary>
        /// Set rating for a single wire connection
        /// </summary>
        private bool SetSingleWireRating(Connector connector, double maxCurrent, double requiredCurrent)
        {
            if (wireCapacityTable == null || wireCapacityTable.Count == 0)
            {
                Console.WriteLine($"Wire {GetConnectorName(connector)}: Wire capacity table not available");
                return false;
            }

            // Get current conductor size to determine wire system type
            string currentConductorSize = connector.Properties["Conductor Size"];
            var wireSystemInfo = ParseWireSystem(currentConductorSize);

            if (wireSystemInfo.wireCount == 0)
            {
                Console.WriteLine($"Wire {GetConnectorName(connector)}: Could not parse wire system '{currentConductorSize}'");
                return false;
            }

            // Find minimum wire size for the main conductors considering voltage drop
            var result = FindMinimumWireSizeWithVoltageDrop(requiredCurrent, connector, maxCurrent, wireSystemInfo);
            if (result.size <= 0)
            {
                Console.WriteLine($"Wire {GetConnectorName(connector)}: No suitable wire size found (Required: {requiredCurrent:F1} A)");
                return false;
            }

            // Find suitable wiring option from database that meets current requirement
            string oldConductorSize = currentConductorSize;
            string newConductorSize = oldConductorSize;
            
            try
            {
                var wiringOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("Wiring", 2).Properties
                    .Where(row => 
                    {
                        var allColumns = row.Keys.ToList();
                        var rateIndex = allColumns.IndexOf("Rate");
                        var columnsToCheck = allColumns
                            .Take(rateIndex == -1 ? allColumns.Count : rateIndex)
                            .Where(key => key != "Conductor Size");
                        
                        return columnsToCheck.All(column => 
                            row[column]?.ToString() == connector.Properties[column]?.ToString());
                    })
                    .OrderBy(row => GetWireSystemPriority(row["Conductor Size"]?.ToString(), wireSystemInfo))
                    .ToList();

                if (wiringOptions.Any())
                {
                    // Find the optimal wiring option that meets the current requirement
                    var selectedWiring = SelectOptimalWiring(wiringOptions, requiredCurrent, wireSystemInfo, connector, maxCurrent);
                    
                    if (selectedWiring != null)
                    {
                        newConductorSize = selectedWiring["Conductor Size"]?.ToString() ?? oldConductorSize;
                        
                        // Update all matching keys from selectedWiring to properties
                        foreach (var key in selectedWiring.Keys)
                        {
                            if (connector.Properties.ContainsKey(key))
                            {
                                connector.Properties[key] = selectedWiring[key];
                            }
                        }
                        
                        Console.WriteLine($"Wire {GetConnectorName(connector)}: Selected from database options");
                    }
                    else
                    {
                        Console.WriteLine($"Wire {GetConnectorName(connector)}: No suitable wiring option found in database");
                        return false;
                    }
                }
                else
                {
                    Console.WriteLine($"Wire {GetConnectorName(connector)}: No matching wiring options in database");
                    return false;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Warning: Could not select wiring from database: {ex.Message}");
                return false;
            }


            
            // Get the actual rated current from the selected wire size
            var selectedSystem = ParseWireSystem(newConductorSize);
            int actualRatedCurrent = 0;
            if (wireCapacityTable.ContainsKey(selectedSystem.mainSize))
            {
                actualRatedCurrent = wireCapacityTable[selectedSystem.mainSize];
            }
            
            // Add voltage drop information to log message
            string voltageDropMsg = "";
            if (ApplicationSettings.Instance.VoltageDropEnabled && connector.Length > 0)
            {
                string conductor = "Copper"; // Default
                if (connector.Properties.ContainsKey("MaterialType"))
                {
                    var materialType = connector.Properties["MaterialType"];
                    if (materialType.Contains("Al", StringComparison.OrdinalIgnoreCase) || 
                        materialType.Contains("Aluminium", StringComparison.OrdinalIgnoreCase))
                    {
                        conductor = "Aluminium";
                    }
                }
                double voltageDrop = VoltageDropCalculator.CalculateWireVoltageDrop(conductor, selectedSystem.mainSize, maxCurrent, connector.Length);
                voltageDropMsg = $" [VDrop: {voltageDrop:F3}V]";
            }
            
            Console.WriteLine($"Wire {GetConnectorName(connector)}: {oldConductorSize} -> {newConductorSize} (Required: {requiredCurrent:F1} A, Rated: {actualRatedCurrent} A){voltageDropMsg}");
            return true;
        }

        /// <summary>
        /// Map raw core type string to standardized category
        /// </summary>
        private string MapCoreType(string rawCore)
        {
            if (string.IsNullOrWhiteSpace(rawCore))
                return "Twin Core"; // Default

            string core = rawCore.Trim();

            // Single core
            if (core.Contains("1 Core", StringComparison.OrdinalIgnoreCase) ||
                core.Contains("Single", StringComparison.OrdinalIgnoreCase))
                return "Single Core";

            // Twin core (2 core)
            if (core.Contains("2 Core", StringComparison.OrdinalIgnoreCase) ||
                core.Contains("Twin", StringComparison.OrdinalIgnoreCase))
                return "Twin Core";

            // 3 or 4 core
            if (core.Contains("3 Core", StringComparison.OrdinalIgnoreCase) ||
                core.Contains("4 Core", StringComparison.OrdinalIgnoreCase) ||
                core.Contains("3.5 Core", StringComparison.OrdinalIgnoreCase))
                return "3-4 Core";

            // Default to Twin Core
            return "Twin Core";
        }

        /// <summary>
        /// Find minimum cable size that meets the required current
        /// </summary>
        private (double size, int ratedCurrent, bool isOverflow) FindMinimumCableSize(
            string conductor, 
            string coreCategory, 
            double requiredCurrent)
        {
            // Check if conductor exists in tables
            if (!cableCapacityTables.ContainsKey(conductor))
            {
                Console.WriteLine($"Warning: Conductor type '{conductor}' not found in capacity tables");
                return (0, 0, false);
            }

            var conductorTable = cableCapacityTables[conductor];

            // Check if core category exists
            if (!conductorTable.ContainsKey(coreCategory))
            {
                Console.WriteLine($"Warning: Core category '{coreCategory}' not found for {conductor}");
                return (0, 0, false);
            }

            var sizeTable = conductorTable[coreCategory];

            if (!sizeTable.Any())
            {
                Console.WriteLine($"Warning: No sizes found for {conductor} {coreCategory}");
                return (0, 0, false);
            }

            // Find the smallest size that meets or exceeds the required current
            foreach (var entry in sizeTable)
            {
                if (entry.Value >= requiredCurrent)
                {
                    return (entry.Key, entry.Value, false);
                }
            }

            // If no size is sufficient, return the largest available (overflow condition)
            var largest = sizeTable.Last();
            return (largest.Key, largest.Value, true);
        }

        /// <summary>
        /// Find minimum cable size considering voltage drop
        /// </summary>
        private (double size, int ratedCurrent, bool isOverflow) FindMinimumCableSizeWithVoltageDrop(
            string conductor, 
            string coreCategory, 
            double requiredCurrent,
            Connector connector,
            double actualCurrent)
        {
            // First find minimum size based on current capacity
            var result = FindMinimumCableSize(conductor, coreCategory, requiredCurrent);
            
            if (result.size <= 0) return result;

            // If voltage drop is disabled or length is 0, return the current capacity result
            if (!ApplicationSettings.Instance.VoltageDropEnabled || connector.Length <= 0)
            {
                return result;
            }

            // Check voltage drop compliance
            if (VoltageDropCalculator.CheckVoltageDropCompliance(conductor, result.size, actualCurrent, connector.Length, -1, 230.0, false, coreCategory))
            {
                return result;
            }

            // If not compliant, try larger sizes
            if (!cableCapacityTables.ContainsKey(conductor) || !cableCapacityTables[conductor].ContainsKey(coreCategory))
            {
                return result;
            }

            var sizeTable = cableCapacityTables[conductor][coreCategory];
            
            // Start checking from the next size up
            foreach (var entry in sizeTable)
            {
                if (entry.Key > result.size)
                {
                    if (VoltageDropCalculator.CheckVoltageDropCompliance(conductor, entry.Key, actualCurrent, connector.Length, -1, 230.0, false, coreCategory))
                    {
                        Console.WriteLine($"Cable {GetConnectorName(connector)}: Upsized from {result.size} to {entry.Key} sq.mm for voltage drop compliance");
                        return (entry.Key, entry.Value, false);
                    }
                }
            }

            // If we reach here, even the largest cable doesn't meet voltage drop requirements
            // Return the largest available with overflow flag
            var largest = sizeTable.Last();
            Console.WriteLine($"Cable {GetConnectorName(connector)}: Largest size {largest.Key} sq.mm still fails voltage drop check");
            return (largest.Key, largest.Value, true);
        }

        /// <summary>
        /// Parse wire system information from conductor size string
        /// </summary>
        private (int wireCount, double mainSize, double earthSize, string systemType) ParseWireSystem(string conductorSize)
        {
            if (string.IsNullOrWhiteSpace(conductorSize))
                return (0, 0, 0, "Unknown");

            // Normalize spacing
            conductorSize = conductorSize.Trim();

            // Handle mixed systems like "2 x 2.5 + 1 x 1.5 sq.mm"
            if (conductorSize.Contains("+"))
            {
                var parts = conductorSize.Split('+');
                if (parts.Length == 2)
                {
                    var mainPart = parts[0].Trim();
                    var earthPart = parts[1].Trim();

                    var (mainCount, mainSize) = ExtractWireInfo(mainPart);
                    var (earthCount, earthSize) = ExtractWireInfo(earthPart);

                    if (mainCount > 0 && mainSize > 0 && earthCount > 0 && earthSize > 0)
                    {
                        int totalWires = mainCount + earthCount;
                        string systemType = DetermineSystemType(totalWires, true);
                        return (totalWires, mainSize, earthSize, systemType);
                    }
                }
            }
            else
            {
                // Handle simple systems like "3 x 2.5 sq.mm"
                var (count, size) = ExtractWireInfo(conductorSize);
                if (count > 0 && size > 0)
                {
                    string systemType = DetermineSystemType(count, false);
                    return (count, size, 0, systemType);
                }
            }

            return (0, 0, 0, "Unknown");
        }

        /// <summary>
        /// Extract wire count and size from a single part like "2 x 2.5 sq.mm"
        /// </summary>
        private (int count, double size) ExtractWireInfo(string part)
        {
            if (string.IsNullOrWhiteSpace(part))
                return (0, 0);

            // Split on 'x' or 'X'
            var segments = part.Split(new[] { 'x', 'X' }, StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length >= 2)
            {
                // Extract count (first part)
                var countMatch = Regex.Match(segments[0], @"\d+");
                // Extract size (second part)
                var sizeMatch = Regex.Match(segments[1], @"\d+\.?\d*");

                if (countMatch.Success && sizeMatch.Success)
                {
                    int count = int.Parse(countMatch.Value);
                    double size = double.Parse(sizeMatch.Value);
                    return (count, size);
                }
            }

            return (0, 0);
        }

        /// <summary>
        /// Determine system type based on wire count
        /// </summary>
        private string DetermineSystemType(int wireCount, bool hasSeparateEarth)
        {
            if (hasSeparateEarth)
            {
                return wireCount switch
                {
                    3 => "2-wire + earth", // 2 main + 1 earth
                    4 => "2-wire + earth", // 2 main + 2 earth
                    5 => "3-wire + earth", // 3 main + 2 earth
                    6 => "4-wire + earth", // 4 main + 2 earth
                    7 => "5-wire + earth", // 5 main + 2 earth
                    _ => $"{wireCount}-wire mixed"
                };
            }
            else
            {
                return wireCount switch
                {
                    2 => "2-wire",
                    3 => "3-wire",
                    4 => "4-wire",
                    _ => $"{wireCount}-wire"
                };
            }
        }

        /// <summary>
        /// Get priority score for sorting wire systems (closer match to target system is better)
        /// </summary>
        private int GetWireSystemPriority(string conductorSize, (int wireCount, double mainSize, double earthSize, string systemType) targetSystem)
        {
            var currentSystem = ParseWireSystem(conductorSize);
            
            // Mismatch in wire count is bad
            if (currentSystem.wireCount != targetSystem.wireCount)
                return 1000 + Math.Abs(currentSystem.wireCount - targetSystem.wireCount);
            
            // Mismatch in system type is bad
            if (currentSystem.systemType != targetSystem.systemType)
                return 500;

            // Match is good, sort by main size (smallest first)
            return (int)(currentSystem.mainSize * 10);
        }

        /// <summary>
        /// Find minimum wire size considering voltage drop
        /// </summary>
        private (double size, int ratedCurrent, bool isOverflow) FindMinimumWireSizeWithVoltageDrop(
            double requiredCurrent,
            Connector connector,
            double actualCurrent,
            (int wireCount, double mainSize, double earthSize, string systemType) systemInfo)
        {
            // Find minimum size based on current capacity
            var result = FindMinimumWireSize(requiredCurrent);
            
            if (result.size <= 0) return result;

            // If voltage drop is disabled or length is 0, return the current capacity result
            if (!ApplicationSettings.Instance.VoltageDropEnabled || connector.Length <= 0)
            {
                return result;
            }

            // Determine conductor material
            string conductor = "Copper"; // Default
            if (connector.Properties.ContainsKey("MaterialType"))
            {
                var materialType = connector.Properties["MaterialType"];
                if (materialType.Contains("Al", StringComparison.OrdinalIgnoreCase) || 
                    materialType.Contains("Aluminium", StringComparison.OrdinalIgnoreCase))
                {
                    conductor = "Aluminium";
                }
            }

            // Check voltage drop compliance (wires are typically single-phase)
            if (VoltageDropCalculator.CheckVoltageDropCompliance(conductor, result.size, actualCurrent, connector.Length, isThreePhase: false, isWire: true))
            {
                return result;
            }

            // If not compliant, try larger sizes
            if (wireCapacityTable == null) return result;

            // Get all available wire sizes sorted
            var availableSizes = wireCapacityTable.Keys.OrderBy(k => k).ToList();
            
            // Start checking from the next size up
            foreach (var size in availableSizes)
            {
                if (size > result.size)
                {
                    if (VoltageDropCalculator.CheckVoltageDropCompliance(conductor, size, actualCurrent, connector.Length, isThreePhase: false, isWire: true))
                    {
                        Console.WriteLine($"Wire {GetConnectorName(connector)}: Upsized from {result.size} to {size} sq.mm for voltage drop compliance");
                        return (size, wireCapacityTable[size], false);
                    }
                }
            }

            // If we reach here, even the largest wire doesn't meet voltage drop requirements
            var largestSize = availableSizes.Last();
            Console.WriteLine($"Wire {GetConnectorName(connector)}: Largest size {largestSize} sq.mm still fails voltage drop check");
            return (largestSize, wireCapacityTable[largestSize], true);
        }

        /// <summary>
        /// Find minimum wire size that meets the required current
        /// </summary>
        private (double size, int ratedCurrent, bool isOverflow) FindMinimumWireSize(double requiredCurrent)
        {
            if (wireCapacityTable == null || !wireCapacityTable.Any())
            {
                Console.WriteLine("Warning: Wire capacity table is empty");
                return (0, 0, false);
            }

            // Find the smallest size that meets or exceeds the required current
            foreach (var entry in wireCapacityTable.OrderBy(k => k.Key))
            {
                if (entry.Value >= requiredCurrent)
                {
                    return (entry.Key, entry.Value, false);
                }
            }

            // If no size is sufficient, return the largest available (overflow condition)
            var largest = wireCapacityTable.OrderBy(k => k.Key).Last();
            return (largest.Key, largest.Value, true);
        }

        /// <summary>
        /// Select optimal wiring option from database
        /// </summary>
        private Dictionary<string, string> SelectOptimalWiring(
            List<Dictionary<string, string>> options, 
            double requiredCurrent,
            (int wireCount, double mainSize, double earthSize, string systemType) targetSystem,
            Connector connector,
            double actualCurrent)
        {
            // Filter options that meet the minimum size requirement
            // We need to parse each option's conductor size to get the main size
            var suitableOptions = new List<Dictionary<string, string>>();
            
            // Determine minimum main size needed
            var minSizeResult = FindMinimumWireSizeWithVoltageDrop(requiredCurrent, connector, actualCurrent, targetSystem);
            double minMainSize = minSizeResult.size;

            foreach (var option in options)
            {
                var optionSizeStr = option["Conductor Size"]?.ToString();
                var optionSystem = ParseWireSystem(optionSizeStr);
                
                // Must match wire count and system type
                if (optionSystem.wireCount == targetSystem.wireCount && 
                    optionSystem.systemType == targetSystem.systemType &&
                    optionSystem.mainSize >= minMainSize)
                {
                    suitableOptions.Add(option);
                }
            }

            if (!suitableOptions.Any())
            {
                // Fallback: try to find any option with sufficient main size, even if system type is slightly different (but wire count should match)
                suitableOptions = options.Where(option => 
                {
                    var optionSizeStr = option["Conductor Size"]?.ToString();
                    var optionSystem = ParseWireSystem(optionSizeStr);
                    return optionSystem.wireCount == targetSystem.wireCount && optionSystem.mainSize >= minMainSize;
                }).ToList();
            }

            if (!suitableOptions.Any())
            {
                // Last resort: just find largest available
                return options.OrderByDescending(option => 
                {
                    var optionSizeStr = option["Conductor Size"]?.ToString();
                    var optionSystem = ParseWireSystem(optionSizeStr);
                    return optionSystem.mainSize;
                }).FirstOrDefault();
            }

            // Select the one with the smallest main size that meets requirements (most economical)
            return suitableOptions.OrderBy(option => 
            {
                var optionSizeStr = option["Conductor Size"]?.ToString();
                var optionSystem = ParseWireSystem(optionSizeStr);
                return optionSystem.mainSize;
            }).FirstOrDefault();
        }



        /// <summary>
        /// Get a readable name for the connector
        /// </summary>
        private string GetConnectorName(Connector connector)
        {
            string source = connector.SourceItem?.Name ?? "Unknown";
            string target = connector.TargetItem?.Name ?? "Unknown";
            return $"{source}->{target}";
        }

        #region Cumulative Voltage Drop

        /// <summary>
        /// Class to store a complete path from Source to Load with voltage drop information
        /// </summary>
        public class VoltageDropPath
        {
            public CanvasItem SourceItem { get; set; }
            public CanvasItem LoadItem { get; set; }
            public List<Connector> Connectors { get; set; } = new List<Connector>();
            public double TotalLengthMeters { get; set; }
            public double CumulativeVoltageDrop { get; set; }
            public double CumulativeVoltageDropPercent { get; set; }
            public double SupplyVoltage { get; set; }
            public bool IsCompliant { get; set; }
            
            public override string ToString()
            {
                var connectorNames = Connectors.Select(c => $"{c.SourceItem?.Name ?? "?"}->{c.TargetItem?.Name ?? "?"}");
                return $"[{string.Join(" -> ", connectorNames)}] VD={CumulativeVoltageDrop:F3}V ({CumulativeVoltageDropPercent:F2}%)";
            }
        }

        // Storage for paths and cumulative VD info per connector
        private Dictionary<CanvasItem, List<VoltageDropPath>> loadPaths = new Dictionary<CanvasItem, List<VoltageDropPath>>();
        private Dictionary<Connector, double> connectorUpstreamVD = new Dictionary<Connector, double>();

        /// <summary>
        /// Discover all paths from Source items to Load items (items with Power property)
        /// </summary>
        private void DiscoverVoltagePaths()
        {
            Console.WriteLine("\n========== CUMULATIVE VOLTAGE DROP: PATH DISCOVERY ==========");
            loadPaths.Clear();
            connectorUpstreamVD.Clear();

            // Find all Source items
            var sources = allItems.Where(item => item.Name == "Source").ToList();
            Console.WriteLine($"Found {sources.Count} Source item(s)");

            // Find all Load items (items with Power property)
            var loads = allItems.Where(item => 
                item.Properties != null && 
                item.Properties.Any() && 
                item.Properties.First().ContainsKey("Power")).ToList();
            Console.WriteLine($"Found {loads.Count} Load item(s) with Power property");

            foreach (var load in loads)
            {
                Console.WriteLine($"  - {load.Name}: Power = {load.Properties.First().GetValueOrDefault("Power", "?")}");
            }

            // For each source, trace all paths to loads
            foreach (var source in sources)
            {
                Console.WriteLine($"\n--- Tracing paths from Source: {source.Name} (ID: {source.UniqueID}) ---");
                
                // Get supply voltage from Source properties
                double supplyVoltage = 230.0;
                if (source.Properties != null && source.Properties.Any())
                {
                    var props = source.Properties.First();
                    if (props.ContainsKey("Voltage"))
                    {
                        string voltageStr = props["Voltage"];
                        if (voltageStr.Contains("415")) supplyVoltage = 415.0;
                        else if (voltageStr.Contains("440")) supplyVoltage = 440.0;
                    }
                    if (props.ContainsKey("Type") && props["Type"].Contains("3-phase"))
                    {
                        supplyVoltage = 415.0;
                    }
                }
                Console.WriteLine($"Supply Voltage: {supplyVoltage}V");

                // Find all connectors originating from this source
                var sourceConnectors = allConnectors.Where(c => c.SourceItem == source).ToList();
                Console.WriteLine($"Found {sourceConnectors.Count} outgoing connector(s) from Source");

                foreach (var startConnector in sourceConnectors)
                {
                    // Trace path from this connector
                    TracePath(startConnector, source, supplyVoltage, new List<Connector>(), new HashSet<string>());
                }
            }

            // Calculate summary
            int totalPaths = loadPaths.Values.Sum(p => p.Count);
            int compliantPaths = loadPaths.Values.SelectMany(p => p).Count(p => p.IsCompliant);
            Console.WriteLine($"\n========== PATH DISCOVERY COMPLETE ==========");
            Console.WriteLine($"Total paths found: {totalPaths}");
            Console.WriteLine($"Compliant paths: {compliantPaths}");
            Console.WriteLine($"Non-compliant paths: {totalPaths - compliantPaths}");
            Console.WriteLine("===============================================\n");
        }

        /// <summary>
        /// Recursively trace paths from a connector to all reachable loads
        /// </summary>
        private void TracePath(Connector connector, CanvasItem source, double supplyVoltage, 
            List<Connector> currentPath, HashSet<string> visited)
        {
            // Create a key for this connector to detect cycles
            string connectorKey = $"{connector.SourceItem?.UniqueID}->{connector.TargetItem?.UniqueID}";
            if (visited.Contains(connectorKey))
            {
                return; // Cycle detected
            }
            visited.Add(connectorKey);

            // Add this connector to the current path
            var newPath = new List<Connector>(currentPath) { connector };

            var targetItem = connector.TargetItem;
            if (targetItem == null)
            {
                return;
            }

            // Check if target is a load (has Power property)
            if (targetItem.Properties != null && 
                targetItem.Properties.Any() && 
                targetItem.Properties.First().ContainsKey("Power"))
            {
                // We found a complete path to a load!
                var vdPath = CreateVoltageDropPath(source, targetItem, newPath, supplyVoltage);
                
                if (!loadPaths.ContainsKey(targetItem))
                {
                    loadPaths[targetItem] = new List<VoltageDropPath>();
                }
                loadPaths[targetItem].Add(vdPath);

                Console.WriteLine($"  PATH FOUND: {source.Name} -> {targetItem.Name}");
                Console.WriteLine($"    Connectors: {newPath.Count}");
                Console.WriteLine($"    Total Length: {vdPath.TotalLengthMeters:F2} m");
                Console.WriteLine($"    Cumulative VD: {vdPath.CumulativeVoltageDrop:F3} V ({vdPath.CumulativeVoltageDropPercent:F2}%)");
                Console.WriteLine($"    Compliant: {vdPath.IsCompliant}");
            }

            // Continue tracing through outgoing connectors from target item
            var outgoingConnectors = allConnectors.Where(c => c.SourceItem == targetItem).ToList();
            foreach (var outConnector in outgoingConnectors)
            {
                TracePath(outConnector, source, supplyVoltage, newPath, new HashSet<string>(visited));
            }
        }

        /// <summary>
        /// Create a VoltageDropPath object with calculated cumulative voltage drop
        /// </summary>
        private VoltageDropPath CreateVoltageDropPath(CanvasItem source, CanvasItem load, 
            List<Connector> connectors, double supplyVoltage)
        {
            var path = new VoltageDropPath
            {
                SourceItem = source,
                LoadItem = load,
                Connectors = connectors,
                SupplyVoltage = supplyVoltage
            };

            double cumulativeVD = 0;
            double totalLength = 0;

            foreach (var connector in connectors)
            {
                double connectorLength = GetConnectorLength(connector);
                totalLength += connectorLength;

                // Calculate voltage drop for this segment
                double segmentVD = CalculateConnectorVoltageDrop(connector);
                cumulativeVD += segmentVD;

                // Store upstream VD for this connector (VD from source to this connector's start)
                if (!connectorUpstreamVD.ContainsKey(connector))
                {
                    // Upstream VD is cumulative VD BEFORE this segment
                    connectorUpstreamVD[connector] = cumulativeVD - segmentVD;
                }
            }

            path.TotalLengthMeters = totalLength;
            path.CumulativeVoltageDrop = cumulativeVD;
            path.CumulativeVoltageDropPercent = (cumulativeVD / supplyVoltage) * 100;
            path.IsCompliant = path.CumulativeVoltageDropPercent <= ApplicationSettings.Instance.MaxVoltageDropPercentage;

            return path;
        }

        /// <summary>
        /// Calculate voltage drop for a single connector segment
        /// </summary>
        /// <summary>
        /// Get the length of a connector, checking both the Length property and Properties dictionary
        /// </summary>
        private double GetConnectorLength(Connector connector)
        {
            // First check the direct Length property
            if (connector.Length > 0)
            {
                return connector.Length;
            }

            // Then check Properties["Length"] (from frontend Properties Panel)
            if (connector.Properties != null && connector.Properties.ContainsKey("Length"))
            {
                string lengthStr = connector.Properties["Length"];
                // Handle cases like "10", "10.5", "10 m", "10m"
                lengthStr = new string(lengthStr.Where(c => char.IsDigit(c) || c == '.').ToArray());
                if (double.TryParse(lengthStr, out double length) && length > 0)
                {
                    return length;
                }
            }

            return 0;
        }

        private double CalculateConnectorVoltageDrop(Connector connector)
        {
            double length = GetConnectorLength(connector);

            if (connector.Properties == null || !connector.Properties.Any())
            {
                return 0;
            }
            
            if (length <= 0)
            {
                return 0;
            }

            try
            {
                // Get current from connector CurrentValues
                double current = 0;
                if (connector.CurrentValues != null && connector.CurrentValues.ContainsKey("Current"))
                {
                    string currentStr = connector.CurrentValues["Current"];
                    double.TryParse(currentStr.Split(' ')[0], out current);
                }

                if (current <= 0)
                {
                    return 0;
                }

                // Get conductor properties
                string conductor = connector.Properties.ContainsKey("Material") ? connector.Properties["Material"] :
                                  (connector.Properties.ContainsKey("Conductor") ? connector.Properties["Conductor"] : "Copper");

                bool isWire = connector.MaterialType == "Wiring" || connector.Properties.ContainsKey("Conductor Size");

                // Get size
                double size = 0;
                if (isWire && connector.Properties.ContainsKey("Conductor Size"))
                {
                    var system = ParseWireSystem(connector.Properties["Conductor Size"]);
                    size = system.mainSize;
                }
                else if (connector.Properties.ContainsKey("Size"))
                {
                    string sizeStr = connector.Properties["Size"];
                    var match = Regex.Match(sizeStr, @"[\d]+(\.[\d]+)?");
                    if (match.Success)
                    {
                        double.TryParse(match.Value, out size);
                    }
                }

                if (size <= 0)
                {
                    return 0;
                }

                // Calculate voltage drop using the corrected length
                double voltageDrop = 0;
                if (isWire)
                {
                    voltageDrop = VoltageDropCalculator.CalculateWireVoltageDrop(conductor, size, current, length);
                }
                else
                {
                    string coreCategory = connector.Properties.ContainsKey("Core") ? connector.Properties["Core"] : "Twin Core";
                    voltageDrop = VoltageDropCalculator.CalculateCableVoltageDrop(conductor, coreCategory, size, current, length);
                }

                return voltageDrop;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error calculating VD for connector: {ex.Message}");
                return 0;
            }
        }

        /// <summary>
        /// Get the upstream cumulative voltage drop for a connector
        /// </summary>
        public double GetUpstreamVoltageDrop(Connector connector)
        {
            if (connectorUpstreamVD.ContainsKey(connector))
            {
                return connectorUpstreamVD[connector];
            }
            return 0;
        }

        /// <summary>
        /// Get the maximum allowed voltage drop for a connector considering upstream VD
        /// </summary>
        public double GetRemainingVDBudget(Connector connector, double supplyVoltage)
        {
            double maxAllowedPercent = ApplicationSettings.Instance.MaxVoltageDropPercentage;
            double maxAllowedVD = supplyVoltage * (maxAllowedPercent / 100.0);
            double upstreamVD = GetUpstreamVoltageDrop(connector);
            double remainingBudget = maxAllowedVD - upstreamVD;
            
            return Math.Max(0, remainingBudget);
        }

        /// <summary>
        /// Print detailed cumulative voltage drop report for debugging
        /// </summary>
        public void PrintCumulativeVDReport()
        {
            Console.WriteLine("\n========== CUMULATIVE VOLTAGE DROP REPORT ==========");
            
            double maxAllowedPercent = ApplicationSettings.Instance.MaxVoltageDropPercentage;
            Console.WriteLine($"Max Allowed Voltage Drop: {maxAllowedPercent}%\n");

            if (loadPaths.Count == 0)
            {
                Console.WriteLine("No paths discovered. Run DiscoverVoltagePaths() first.");
                return;
            }

            foreach (var kvp in loadPaths)
            {
                var load = kvp.Key;
                var paths = kvp.Value;

                Console.WriteLine($"LOAD: {load.Name}");
                Console.WriteLine($"  Power: {load.Properties?.FirstOrDefault()?.GetValueOrDefault("Power", "?")}");
                Console.WriteLine($"  Paths to this load: {paths.Count}");

                foreach (var path in paths)
                {
                    Console.WriteLine($"\n  Path from {path.SourceItem?.Name}:");
                    Console.WriteLine($"  ┌─────────────────────────────────────────────────────────────");

                    double cumulativeVD = 0;
                    for (int i = 0; i < path.Connectors.Count; i++)
                    {
                        var conn = path.Connectors[i];
                        double segmentVD = CalculateConnectorVoltageDrop(conn);
                        cumulativeVD += segmentVD;

                        string connName = GetConnectorName(conn);
                        string size = "";
                        if (conn.Properties != null)
                        {
                            if (conn.Properties.ContainsKey("Size"))
                                size = conn.Properties["Size"];
                            else if (conn.Properties.ContainsKey("Conductor Size"))
                                size = conn.Properties["Conductor Size"];
                        }
                        
                        double current = 0;
                        if (conn.CurrentValues != null && conn.CurrentValues.ContainsKey("Current"))
                        {
                            double.TryParse(conn.CurrentValues["Current"].Split(' ')[0], out current);
                        }

                        Console.WriteLine($"  │ {i + 1}. {connName}");
                        Console.WriteLine($"  │    Size: {size}, Length: {GetConnectorLength(conn):F2}m, Current: {current:F2}A");
                        Console.WriteLine($"  │    Segment VD: {segmentVD:F3}V, Cumulative VD: {cumulativeVD:F3}V ({(cumulativeVD / path.SupplyVoltage * 100):F2}%)");
                    }

                    Console.WriteLine($"  └─────────────────────────────────────────────────────────────");
                    Console.WriteLine($"  TOTAL: VD = {path.CumulativeVoltageDrop:F3}V ({path.CumulativeVoltageDropPercent:F2}%) - {(path.IsCompliant ? "✓ COMPLIANT" : "✗ EXCEEDS LIMIT")}");
                }
                Console.WriteLine();
            }

            // Summary
            var allPaths = loadPaths.Values.SelectMany(p => p).ToList();
            var nonCompliantPaths = allPaths.Where(p => !p.IsCompliant).ToList();

            Console.WriteLine("========== SUMMARY ==========");
            Console.WriteLine($"Total paths: {allPaths.Count}");
            Console.WriteLine($"Compliant paths: {allPaths.Count - nonCompliantPaths.Count}");
            Console.WriteLine($"Non-compliant paths: {nonCompliantPaths.Count}");

            if (nonCompliantPaths.Any())
            {
                Console.WriteLine("\n⚠ NON-COMPLIANT PATHS:");
                foreach (var path in nonCompliantPaths)
                {
                    Console.WriteLine($"  - {path.SourceItem?.Name} -> {path.LoadItem?.Name}: {path.CumulativeVoltageDropPercent:F2}% (max: {maxAllowedPercent}%)");
                }
            }

            Console.WriteLine("====================================\n");
        }

        /// <summary>
        /// Analyze voltage drop without modifying the network (for reporting)
        /// </summary>
        public void AnalyzeVoltageDrop()
        {
            DiscoverVoltagePaths();
        }

        /// <summary>
        /// Get structured data for the cumulative voltage drop report
        /// </summary>
        public CumulativeReportData GetCumulativeReportData()
        {
            var data = new CumulativeReportData
            {
                MaxAllowedPercent = ApplicationSettings.Instance.MaxVoltageDropPercentage,
                ProcessLogs = new List<string>(_processLogs)
            };

            if (loadPaths.Count == 0) return data;

            foreach (var kvp in loadPaths)
            {
                var load = kvp.Key;
                var paths = kvp.Value;
                var loadData = new LoadReportData
                {
                    LoadName = load.Name,
                    Power = load.Properties?.FirstOrDefault()?.GetValueOrDefault("Power", "?")
                };

                foreach (var path in paths)
                {
                    var pathData = new PathReportData
                    {
                        SourceName = path.SourceItem?.Name,
                        SupplyVoltage = path.SupplyVoltage,
                        TotalVD = path.CumulativeVoltageDrop,
                        TotalVDPercent = path.CumulativeVoltageDropPercent,
                        IsCompliant = path.IsCompliant
                    };

                    double cumulativeVD = 0;
                    for (int i = 0; i < path.Connectors.Count; i++)
                    {
                        var conn = path.Connectors[i];
                        double segmentVD = CalculateConnectorVoltageDrop(conn);
                        cumulativeVD += segmentVD;

                        string size = "";
                        if (conn.Properties != null)
                        {
                            if (conn.Properties.ContainsKey("Size"))
                                size = conn.Properties["Size"];
                            else if (conn.Properties.ContainsKey("Conductor Size"))
                                size = conn.Properties["Conductor Size"];
                        }
                        
                        double current = 0;
                        if (conn.CurrentValues != null && conn.CurrentValues.ContainsKey("Current"))
                        {
                            double.TryParse(conn.CurrentValues["Current"].Split(' ')[0], out current);
                        }

                        pathData.Segments.Add(new SegmentReportData
                        {
                            Name = GetConnectorName(conn),
                            Size = size,
                            Length = GetConnectorLength(conn),
                            Current = current,
                            SegmentVD = segmentVD,
                            CumulativeVD = cumulativeVD,
                            CumulativeVDPercent = (cumulativeVD / path.SupplyVoltage * 100)
                        });
                    }
                    loadData.Paths.Add(pathData);
                }
                data.Loads.Add(loadData);
            }

            var allPaths = loadPaths.Values.SelectMany(p => p).ToList();
            data.TotalPaths = allPaths.Count;
            data.NonCompliantPaths = allPaths.Count(p => !p.IsCompliant);
            data.CompliantPaths = data.TotalPaths - data.NonCompliantPaths;

            return data;
        }

        /// <summary>
        /// Check if any path to a load exceeds the voltage drop limit
        /// </summary>
        public bool HasVoltageDropViolation()
        {
            return loadPaths.Values.SelectMany(p => p).Any(p => !p.IsCompliant);
        }

        /// <summary>
        /// Get all connectors that are on non-compliant paths
        /// </summary>
        public List<Connector> GetConnectorsOnNonCompliantPaths()
        {
            var result = new HashSet<Connector>();
            foreach (var path in loadPaths.Values.SelectMany(p => p).Where(p => !p.IsCompliant))
            {
                foreach (var connector in path.Connectors)
                {
                    result.Add(connector);
                }
            }
            return result.ToList();
        }

        /// <summary>
        /// Try to upsize a cable/wire to reduce voltage drop for cumulative VD compliance
        /// </summary>
        /// <summary>
        /// Try to upsize a cable/wire to reduce voltage drop for cumulative VD compliance
        /// </summary>
        private bool TryUpsizeCableForCumulativeVD(Connector connector)
        {
            if (connector.Properties == null || !connector.Properties.Any())
            {
                LogProcess($"  {GetConnectorName(connector)}: No properties, cannot upsize");
                return false;
            }

            try
            {
                // Determine if this is a wire or cable
                bool isWire = connector.MaterialType == "Wiring" || connector.Properties.ContainsKey("Conductor Size");
                bool isCable = connector.Properties.ContainsKey("Conductor") && 
                              connector.Properties.ContainsKey("Core") && 
                              connector.Properties.ContainsKey("Size");

                // Get current size
                double currentSize = 0;
                if (isWire && connector.Properties.ContainsKey("Conductor Size"))
                {
                    var system = ParseWireSystem(connector.Properties["Conductor Size"]);
                    currentSize = system.mainSize;
                }
                else if (isCable && connector.Properties.ContainsKey("Size"))
                {
                    string sizeStr = connector.Properties["Size"];
                    var match = Regex.Match(sizeStr, @"[\d]+(\.[\d]+)?");
                    if (match.Success)
                    {
                        double.TryParse(match.Value, out currentSize);
                    }
                }

                if (currentSize <= 0)
                {
                    LogProcess($"  {GetConnectorName(connector)}: Cannot determine current size");
                    return false;
                }

                // Get available sizes and find one size up
                double newSize = 0;

                if (isWire && wireCapacityTable != null)
                {
                    // Find next larger wire size
                    var largerSizes = wireCapacityTable.Keys.Where(s => s > currentSize).OrderBy(s => s).ToList();
                    if (largerSizes.Any())
                    {
                        newSize = largerSizes.First();
                        
                        // Use database lookup to find proper wire format (like SetSingleWireRating)
                        if (connector.Properties.ContainsKey("Conductor Size"))
                        {
                            string oldValue = connector.Properties["Conductor Size"];
                            var wireSystemInfo = ParseWireSystem(oldValue);
                            
                            try
                            {
                                // Load wiring options from database - less strict matching
                                var allWiringOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("Wiring", 2).Properties;
                                
                                // Find a wiring option that has the target main size or larger
                                var suitableWiring = allWiringOptions
                                    .Select(row => new { Row = row, System = ParseWireSystem(row.GetValueOrDefault("Conductor Size", "") ?? "") })
                                    .Where(x => x.System.mainSize >= newSize && x.System.wireCount == wireSystemInfo.wireCount)
                                    .OrderBy(x => x.System.mainSize)
                                    .FirstOrDefault();
                                
                                if (suitableWiring != null)
                                {
                                    // Update all matching keys from selected wiring to properties
                                    foreach (var key in suitableWiring.Row.Keys)
                                    {
                                        if (connector.Properties.ContainsKey(key))
                                        {
                                            connector.Properties[key] = suitableWiring.Row[key];
                                        }
                                    }
                                    LogProcess($"  Wire {GetConnectorName(connector)}: Upsized from {currentSize} to {newSize} sq.mm");
                                    return true;
                                }
                                else
                                {
                                    // Fallback: just look for any wire with the larger size
                                    var anyLargerWire = allWiringOptions
                                        .Select(row => new { Row = row, System = ParseWireSystem(row.GetValueOrDefault("Conductor Size", "") ?? "") })
                                        .Where(x => x.System.mainSize >= newSize)
                                        .OrderBy(x => x.System.mainSize)
                                        .ThenByDescending(x => x.System.wireCount == wireSystemInfo.wireCount ? 1 : 0)
                                        .FirstOrDefault();
                                    
                                    if (anyLargerWire != null)
                                    {
                                        foreach (var key in anyLargerWire.Row.Keys)
                                        {
                                            if (connector.Properties.ContainsKey(key))
                                            {
                                                connector.Properties[key] = anyLargerWire.Row[key];
                                            }
                                        }
                                        LogProcess($"  Wire {GetConnectorName(connector)}: Upsized from {currentSize} to {newSize} sq.mm (Fallback)");
                                        return true;
                                    }
                                }
                            }
                            catch (Exception ex)
                            {
                                LogProcess($"    Error loading wiring options: {ex.Message}");
                            }
                        }
                        
                        // If we reach here, it means we found a size in capacity table but no matching wire in DB
                        LogProcess($"  Wire {GetConnectorName(connector)}: Cannot upsize to {newSize} sq.mm (No matching wire option found). Keeping at {currentSize} sq.mm.");
                        return false;
                    }
                    else
                    {
                        LogProcess($"  Wire {GetConnectorName(connector)}: Already at max size ({currentSize} sq.mm)");
                        return false;
                    }
                }
                else if (isCable && cableCapacityTables != null)
                {
                    // Find next larger cable size
                    string conductor = connector.Properties.ContainsKey("Conductor") ? connector.Properties["Conductor"] : "Copper";
                    string coreCategory = connector.Properties.ContainsKey("Core") ? connector.Properties["Core"] : "Twin Core";
                    string mappedCore = MapCoreType(coreCategory);

                    if (cableCapacityTables.ContainsKey(conductor) && 
                        cableCapacityTables[conductor].ContainsKey(mappedCore))
                    {
                        var sizeTable = cableCapacityTables[conductor][mappedCore];
                        var largerSizes = sizeTable.Keys.Where(s => s > currentSize).OrderBy(s => s).ToList();
                        
                        if (largerSizes.Any())
                        {
                            newSize = largerSizes.First();
                            
                            // Try to find full properties from database
                            try 
                            {
                                var cableOptions = DatabaseLoader.LoadDefaultPropertiesFromDatabase("Cable", 2).Properties
                                    .Where(row => 
                                    {
                                        // Match all properties except Size and Rate
                                        var allColumns = row.Keys.ToList();
                                        var rateIndex = allColumns.IndexOf("Rate");
                                        var columnsToCheck = allColumns
                                            .Take(rateIndex == -1 ? allColumns.Count : rateIndex)
                                            .Where(key => key != "Size");
                                        
                                        return columnsToCheck.All(column => 
                                            row.ContainsKey(column) && connector.Properties.ContainsKey(column) &&
                                            row[column]?.ToString() == connector.Properties[column]?.ToString());
                                    })
                                    .ToList();

                                if (cableOptions.Any())
                                {
                                    // Find option with exact size match first, or closest larger
                                    var selectedCable = cableOptions
                                        .Select(row => {
                                            string sStr = row.GetValueOrDefault("Size", "")?.ToString() ?? "";
                                            var m = Regex.Match(sStr, @"[\d]+(\.[\d]+)?");
                                            double sVal = m.Success && double.TryParse(m.Value, out double v) ? v : 0;
                                            return new { Row = row, Size = sVal };
                                        })
                                        .Where(x => x.Size >= newSize)
                                        .OrderBy(x => x.Size)
                                        .FirstOrDefault();

                                    if (selectedCable != null)
                                    {
                                        // Update all properties
                                        foreach (var key in selectedCable.Row.Keys)
                                        {
                                            if (connector.Properties.ContainsKey(key))
                                            {
                                                connector.Properties[key] = selectedCable.Row[key];
                                            }
                                        }
                                        LogProcess($"  Cable {GetConnectorName(connector)}: Upsized from {currentSize} to {newSize} sq.mm");
                                        return true;
                                    }
                                }
                            }
                            catch (Exception)
                            {
                                // Ignore DB errors and fall back to simple update
                            }

                            // Fallback: just update the size
                            connector.Properties["Size"] = $"{newSize} sq.mm";
                            LogProcess($"  Cable {GetConnectorName(connector)}: Upsized from {currentSize} to {newSize} sq.mm (Fallback)");
                            return true;
                        }
                        else
                        {
                            LogProcess($"  Cable {GetConnectorName(connector)}: Already at max size ({currentSize} sq.mm)");
                            return false;
                        }
                    }
                }

                LogProcess($"  {GetConnectorName(connector)}: Cannot find size table for upsizing");
                return false;
            }
            catch (Exception ex)
            {
                LogProcess($"  Error upsizing {GetConnectorName(connector)}: {ex.Message}");
                return false;
            }
        }

        #endregion
    }
}
