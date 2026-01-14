using System;
using System.Collections.Generic;
using System.Linq;
using Sayanho.Core.Models;

namespace Sayanho.Core.Logic
{
    public class NetworkAnalyzer
    {
        private List<CanvasItem> allItems = new List<CanvasItem>();
        private List<Connector> allConnectors = new List<Connector>();
        private List<CanvasSheet> allSheets;
        private Dictionary<string, CanvasSheet> sheetLookup;

        public NetworkAnalyzer(List<CanvasSheet> sheets)
        {
            allSheets = sheets;
            sheetLookup = new Dictionary<string, CanvasSheet>();
            
            // Create lookup dictionary for quick sheet access by ID
            foreach (var sheet in sheets)
            {
                sheetLookup[sheet.SheetId] = sheet;
            }
            
            // Initialize with items from all sheets
            if (allSheets != null && allSheets.Count > 0)
            { 
                // Collect items and connectors from all sheets
                foreach (var sheet in allSheets)
                {
                    allItems.AddRange(sheet.CanvasItems);
                    allConnectors.AddRange(sheet.StoredConnectors);
                }
            }
        }

        public void AnalyzeNetwork()
        {
            // Reset all current values
            if (allConnectors.Count > 0)
            { 
                foreach (var connector in allConnectors)
                {    
                    if (connector.CurrentValues == null)
                    {
                        connector.CurrentValues = new Dictionary<string, string>();
                        connector.CurrentValues["Current"] = "0 A";
                        connector.CurrentValues["R_Current"] = "0 A";
                        connector.CurrentValues["Y_Current"] = "0 A";
                        connector.CurrentValues["B_Current"] = "0 A";
                    }
                    // Initialize Phase property if not exists
                    if (!connector.CurrentValues.ContainsKey("Phase"))
                    {
                        connector.CurrentValues["Phase"] = "";
                    }
                }
            }

            // Find all sources and loads
            var sources = allItems.Where(item => item.Name == "Source").ToList();
            
            // Process each source
            foreach (var source in sources)
            {
                // Get source voltage
                string voltageStr = "230 V";
                string phaseType = "1-phase";
                
                if (source.Properties != null && source.Properties.Any())
                {
                    var props = source.Properties.First();
                    if (props.ContainsKey("Voltage"))
                    {
                        voltageStr = props["Voltage"];
                    }
                    if (props.ContainsKey("Type"))
                    {
                        phaseType = props["Type"];
                    }
                }

                // Parse voltage value
                float voltage = 230f; // Default to 230V
                if (voltageStr.Contains("415"))
                {
                    voltage = 415f;
                }
                else if (voltageStr.Contains("440"))
                {
                    voltage = 440f;
                }

                // Find all connectors connected to this source
                var sourceConnectors = allConnectors.Where(c => c.SourceItem == source).ToList();
                
                // Process each connector from the source
                foreach (var connector in sourceConnectors)
                { 
                    TraceAndCalculateCurrent(connector, voltage, phaseType, inheritedPhase: "", visited: new HashSet<string>());
                }
            }
        }

        private void TraceAndCalculateCurrent(Connector connector, float voltage, string phaseType, string inheritedPhase = "", HashSet<string> visited = null)
        {
            if (visited == null) visited = new HashSet<string>();
            string edgeKey = GetConnectorKey(connector);
            if (visited.Contains(edgeKey))
            {
                // Cycle detected; prevent infinite recursion
                return;
            }
            visited.Add(edgeKey);

            // Get the target item
            var targetItem = connector.TargetItem;
            
            // Determine the correct voltage to use based on device type
            float currentVoltage = voltage;
            
            // Determine which phase this connector is on
            string phase = inheritedPhase;
            
            // If no inherited phase, determine phase based on source connection
            if (string.IsNullOrEmpty(phase))
            {
                // If the source item is SPN DB, check if it has an inherited phase, otherwise default to R phase
                if (connector.SourceItem != null && connector.SourceItem.Name == "SPN DB")
                {
                    // For outgoing connections from SPN DB, use 230V (single phase)
                    currentVoltage = 230f;
                    
                    // Try to find the phase that feeds this SPN DB
                    var incomingConnectors = allConnectors.Where(c => c.TargetItem == connector.SourceItem).ToList();
                    if (incomingConnectors.Any() && incomingConnectors[0].CurrentValues.ContainsKey("Phase"))
                    {
                        phase = incomingConnectors[0].CurrentValues["Phase"];
                    }
                    else
                    {
                        phase = "R"; // Default to R phase if not specified
                    }
                }
                // If the source item is HTPN DB, determine the phase based on the connection point
                else if (connector.SourceItem != null && connector.SourceItem.Name.Contains("HTPN"))
                {
                    // For outgoing connections from HTPN DB, use 230V (single phase)
                    currentVoltage = 230f;
                    
                    // Determine phase based on the connection point key
                    string sourcePointKey = connector.SourcePointKey;
                    if (sourcePointKey.Contains("R") || sourcePointKey.StartsWith("R"))
                        phase = "R";
                    else if (sourcePointKey.Contains("Y") || sourcePointKey.StartsWith("Y"))
                        phase = "Y";
                    else if (sourcePointKey.Contains("B") || sourcePointKey.StartsWith("B"))
                        phase = "B";
                    else
                        phase = "R"; // Default to R phase if not specified
                }
                // For Main Switch and Change Over Switch, determine phase based on Voltage property
                else if (connector.SourceItem != null && 
                        (connector.SourceItem.Name == "Main Switch" || connector.SourceItem.Name == "Change Over Switch"))
                {
                    if (connector.SourceItem.Name == "Change Over Switch")
                    {
                        // Use the centralized handler for Change Over Switch
                        (currentVoltage, phase) = ChangeOverSwitchHandler.DeterminePhaseAndVoltage(connector.SourceItem);
                        
                        // If it's single phase, try to find the phase that feeds this switch
                        if (currentVoltage == 230f)
                        {
                            var incomingConnectors = allConnectors.Where(c => c.TargetItem == connector.SourceItem).ToList();
                            if (incomingConnectors.Any() && incomingConnectors[0].CurrentValues.ContainsKey("Phase"))
                            {
                                phase = incomingConnectors[0].CurrentValues["Phase"];
                            }
                        }
                    }
                    else // Main Switch
                    {
                        // Default to three phase (415V)
                        currentVoltage = 415f;
                        phase = "ALL";
                        
                        // Check if properties exist and contain Voltage information
                        if (connector.SourceItem.Properties != null && 
                            connector.SourceItem.Properties.Any() && 
                            connector.SourceItem.Properties.First().ContainsKey("Voltage"))
                        {
                            string voltageInfo = connector.SourceItem.Properties.First()["Voltage"];
                            
                            // Check if it's single phase (DP)
                            if (voltageInfo.Contains("DP"))
                            {
                                // Single phase - use 230V
                                currentVoltage = 230f;
                                
                                // Try to find the phase that feeds this switch (like SPN DB)
                                var incomingConnectors = allConnectors.Where(c => c.TargetItem == connector.SourceItem).ToList();
                                if (incomingConnectors.Any() && incomingConnectors[0].CurrentValues.ContainsKey("Phase"))
                                {
                                    phase = incomingConnectors[0].CurrentValues["Phase"];
                                }
                                else
                                {
                                    phase = "R"; // Default to R phase if not specified
                                }
                            }
                        }
                    }
                }
                // For VTPN or other three-phase sources, we'll handle all phases
                else if (connector.SourceItem != null && (connector.SourceItem.Name.Contains("VTPN")||connector.SourceItem.Name.Contains("Cubical Panel")))
                {
                    phase = "ALL";
                }
                // For Source items, determine phase based on the Type property
                else if (connector.SourceItem != null && connector.SourceItem.Name == "Source")
                {  
                    if (connector.SourceItem.Properties != null && connector.SourceItem.Properties.Any())
                    {
                        var props = connector.SourceItem.Properties.First();
                        if (props.ContainsKey("Type") && props["Type"].Contains("3-phase"))
                        {
                            phase = "ALL";
                        }
                        else
                        {
                            phase = "R"; // Default to R phase for single-phase sources
                        }
                    }
                    else
                    {
                        phase = "R"; // Default to R phase if no properties
                    }
                }
                // For MCB, MCCB, and other components, inherit phase from incoming connections if available
                else if (connector.SourceItem != null)
                {
                    // Try to find incoming connections to determine phase
                    var incomingConnectors = allConnectors.Where(c => c.TargetItem == connector.SourceItem).ToList();
                    if (incomingConnectors.Any() && incomingConnectors[0].CurrentValues.ContainsKey("Phase"))
                    {
                        phase = incomingConnectors[0].CurrentValues["Phase"];
                    }
                    else
                    {
                        phase = "R";
                    }
                }
            }
            
            // Store the phase information in the connector CurrentValues
            connector.CurrentValues["Phase"] = phase;
            
            // Check if target is a load with power value
            if (targetItem.Properties != null && 
                targetItem.Properties.Any() && 
                targetItem.Properties.First().ContainsKey("Power"))
            {
                // Get power value
                string powerStr = targetItem.Properties.First()["Power"];
                if (float.TryParse(powerStr.Split(' ')[0], out float power))
                {
                    // Get diversification factor based on load type
                    double diversificationFactor = 1.0; // Default value
                    
                    // Get the load type from the item name
                    string loadType = targetItem.Name;
                    
                    // Apply diversification factor from settings
                    diversificationFactor = ApplicationSettings.GetDiversificationFactor(loadType);
                    
                    // Calculate current using I = P/V with the correct voltage and diversification factor
                    float current = (float)(power * diversificationFactor / currentVoltage);
                    
                    // Store current value in connector properties
                    connector.CurrentValues["Current"] = $"{current:F2} A";
                    
                    // Store which phase this load belongs to in the load's properties
                    if (targetItem.Properties.First().ContainsKey("Phase"))
                    {
                        targetItem.Properties.First()["Phase"] = phase;
                    }
                    else
                    {
                        targetItem.Properties.First().Add("Phase", phase);
                    }
                    
                    // Update phase-specific current values
                    if (phase == "R")
                    {
                        connector.CurrentValues["R_Current"] = $"{current:F2} A";
                        connector.CurrentValues["Y_Current"] = "0 A";
                        connector.CurrentValues["B_Current"] = "0 A";
                    }
                    else if (phase == "Y")
                    {
                        connector.CurrentValues["R_Current"] = "0 A";
                        connector.CurrentValues["Y_Current"] = $"{current:F2} A";
                        connector.CurrentValues["B_Current"] = "0 A";
                    }
                    else if (phase == "B")
                    {
                        connector.CurrentValues["R_Current"] = "0 A";
                        connector.CurrentValues["Y_Current"] = "0 A";
                        connector.CurrentValues["B_Current"] = $"{current:F2} A";
                    }
                    else if (phase == "ALL")
                    {
                        // For three-phase balanced loads, divide by 3
                        float phaseCurrentValue = current / 3;
                        connector.CurrentValues["R_Current"] = $"{phaseCurrentValue:F2} A";
                        connector.CurrentValues["Y_Current"] = $"{phaseCurrentValue:F2} A";
                        connector.CurrentValues["B_Current"] = $"{phaseCurrentValue:F2} A";
                    }
                }
            }
            else if (targetItem.Name == "Portal")
            {
                // Helper to get property value safely
                string GetProp(CanvasItem item, string key) {
                    if (item.Properties != null && item.Properties.Any() && item.Properties.First().ContainsKey(key))
                        return item.Properties.First()[key];
                    return "";
                }

                string dir = GetProp(targetItem, "Direction").ToLower();
                string netId = GetProp(targetItem, "NetId").Trim();

                if (string.IsNullOrEmpty(netId)) return;
                
                // Find counterpart
                var portals = allItems.Where(i => i.Name == "Portal").ToList();
                var sameNet = portals.Where(p => GetProp(p, "NetId").Trim() == netId).ToList();

                // Validation: We expect exactly 2 portals in a pair (IN/OUT agnostic)
                if (sameNet.Count == 2)
                {
                    var counterpart = sameNet.FirstOrDefault(p => p.UniqueID != targetItem.UniqueID);

                    if (counterpart != null)
                    {
                        // Trace from counterpart's outgoing connectors
                        // We filter for connectors where the SOURCE is the counterpart
                        var outConnectors = allConnectors.Where(c => c.SourceItem == counterpart).ToList();
                        
                        float totalCurrent = 0;
                        float rPhaseCurrent = 0;
                        float yPhaseCurrent = 0;
                        float bPhaseCurrent = 0;

                        foreach (var outC in outConnectors)
                        {
                            // Continue trace from the jump point
                            TraceAndCalculateCurrent(outC, currentVoltage, phaseType, phase, visited);

                            // Collect currents
                             if (outC.CurrentValues.ContainsKey("Current"))
                                totalCurrent += float.Parse(outC.CurrentValues["Current"].Split(' ')[0]);
                             if (outC.CurrentValues.ContainsKey("R_Current"))
                                rPhaseCurrent += float.Parse(outC.CurrentValues["R_Current"].Split(' ')[0]);
                             if (outC.CurrentValues.ContainsKey("Y_Current"))
                                yPhaseCurrent += float.Parse(outC.CurrentValues["Y_Current"].Split(' ')[0]);
                             if (outC.CurrentValues.ContainsKey("B_Current"))
                                bPhaseCurrent += float.Parse(outC.CurrentValues["B_Current"].Split(' ')[0]);
                        }

                        // Update THIS incoming connector with the aggregated current
                        connector.CurrentValues["Current"] = $"{totalCurrent:F2} A";
                        connector.CurrentValues["R_Current"] = $"{rPhaseCurrent:F2} A";
                        connector.CurrentValues["Y_Current"] = $"{yPhaseCurrent:F2} A";
                        connector.CurrentValues["B_Current"] = $"{bPhaseCurrent:F2} A";
                    }
                }
            }
            else
            {
                // Find all outgoing connectors from this item
                var outgoingConnectors = allConnectors.Where(c => c.SourceItem == targetItem).ToList();
                
                // If there are outgoing connectors, trace them
                if (outgoingConnectors.Any())
                {
                    float totalCurrent = 0;
                    float rPhaseCurrent = 0;
                    float yPhaseCurrent = 0;
                    float bPhaseCurrent = 0;
                    
                    // For VTPN, we need to handle the three phases
// For VTPN, we need to handle the three phases
                    if (targetItem.Name != null && targetItem.Name.Contains("VTPN"))
                    {
                        // For VTPN, sum up the currents from all phases
                        foreach (var outConnector in outgoingConnectors)
                        {
                            // VTPN outgoing connections use 415V (three phase)
                            // Pass the phase information to the next level
                            TraceAndCalculateCurrent(outConnector, 415f, phaseType, phase, visited);
                            
                            // Add current from this branch
                            if (outConnector.CurrentValues.ContainsKey("Current"))
                            {
                                string currentStr = outConnector.CurrentValues["Current"];
                                if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                {
                                    totalCurrent += branchCurrent;
                                }
                            }
                            
                            // Add phase-specific currents
                            if (outConnector.CurrentValues.ContainsKey("R_Current"))
                            {
                                string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                {
                                    rPhaseCurrent += rBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("Y_Current"))
                            {
                                string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                {
                                    yPhaseCurrent += yBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("B_Current"))
                            {
                                string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                {
                                    bPhaseCurrent += bBranchCurrent;
                                }
                            }
                        }
                    }
                    else if (targetItem.Name != null && targetItem.Name.Contains("Cubical Panel"))
                    {
                        // Cubical Panel Logic: Map Input Section to Output Section
                        int inputSection = 1;
                        string inKey = connector.TargetPointKey ?? "";
                        if (inKey.StartsWith("in"))
                        {
                            int.TryParse(inKey.Substring(2), out inputSection);
                        }

                        foreach (var outConnector in outgoingConnectors)
                        {
                            string outKey = outConnector.SourcePointKey ?? "";
                            int outIndex = -1;
                            if (outKey.StartsWith("out"))
                            {
                                if (int.TryParse(outKey.Substring(3), out int parsedIdx))
                                {
                                    outIndex = parsedIdx - 1; // 1-based to 0-based
                                }
                            }

                            bool belongsToSection = false;
                            if (outIndex >= 0 && targetItem.Outgoing != null && outIndex < targetItem.Outgoing.Count)
                            {
                                var outProp = targetItem.Outgoing[outIndex];
                                if (outProp.ContainsKey("Section"))
                                {
                                    if (int.TryParse(outProp["Section"], out int secId) && secId == inputSection)
                                    {
                                        belongsToSection = true;
                                    }
                                }
                                else if (inputSection == 1) // Default to section 1
                                {
                                    belongsToSection = true;
                                }
                            }

                            if (belongsToSection)
                            {
                                // Determine correct voltage/phase for this outgoing based on its configuration.
                                // This keeps backend analysis aligned with the frontend NetworkAnalyzer.
                                float linkVoltage = 415f;
                                string linkPhase = "ALL";

                                if (outIndex >= 0 && targetItem.Outgoing != null && outIndex < targetItem.Outgoing.Count)
                                {
                                    var outProp = targetItem.Outgoing[outIndex];
                                    string pole = outProp.GetValueOrDefault("Pole", "");
                                    string selectedPhase = outProp.GetValueOrDefault("Phase", "");

                                    // Single-phase outgoings (DP/SP/1P) should be analyzed at 230V on the selected phase.
                                    if (!string.IsNullOrEmpty(pole) &&
                                        (pole.StartsWith("DP", StringComparison.OrdinalIgnoreCase) ||
                                         pole.StartsWith("SP", StringComparison.OrdinalIgnoreCase) ||
                                         pole.StartsWith("1P", StringComparison.OrdinalIgnoreCase)))
                                    {
                                        linkVoltage = 230f;

                                        if (!string.IsNullOrEmpty(selectedPhase))
                                        {
                                            linkPhase = selectedPhase;
                                        }
                                        else
                                        {
                                            // If phase isn't explicitly set, fall back to inherited phase if it's a single phase.
                                            // If inherited is "ALL", default to R.
                                            linkPhase = string.Equals(phase, "ALL", StringComparison.OrdinalIgnoreCase) ? "R" : phase;
                                            if (string.IsNullOrEmpty(linkPhase)) linkPhase = "R";
                                        }
                                    }
                                    else
                                    {
                                        linkVoltage = 415f;
                                        linkPhase = "ALL";
                                    }
                                }

                                TraceAndCalculateCurrent(outConnector, linkVoltage, phaseType, linkPhase, visited);

                                if (outConnector.CurrentValues.ContainsKey("Current"))
                                {
                                    string currentStr = outConnector.CurrentValues["Current"];
                                    if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                    {
                                        totalCurrent += branchCurrent;
                                    }
                                }
                                
                                if (outConnector.CurrentValues.ContainsKey("R_Current"))
                                {
                                    string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                    if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                        rPhaseCurrent += rBranchCurrent;
                                }
                                
                                if (outConnector.CurrentValues.ContainsKey("Y_Current"))
                                {
                                    string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                    if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                        yPhaseCurrent += yBranchCurrent;
                                }
                                
                                if (outConnector.CurrentValues.ContainsKey("B_Current"))
                                {
                                    string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                    if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                        bPhaseCurrent += bBranchCurrent;
                                }
                            }
                        }
                    }
                    else if (targetItem.Name != null && targetItem.Name == "SPN DB")
                    {
                        // For SPN DB, process each outgoing connector
                        // The phase is inherited from the incoming connection
                        string spnPhase = phase;
                        
                        foreach (var outConnector in outgoingConnectors)
                        {
                            // Pass the inherited phase to all outgoing connections
                            TraceAndCalculateCurrent(outConnector, 230f, phaseType, spnPhase, visited);
                            
                            // Add current from this branch
                            if (outConnector.CurrentValues.ContainsKey("Current"))
                            {
                                string currentStr = outConnector.CurrentValues["Current"];
                                if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                {
                                    totalCurrent += branchCurrent;
                                }
                            }
                            
                            // Add current to the appropriate phase based on the inherited phase
                            if (spnPhase == "R" && outConnector.CurrentValues.ContainsKey("R_Current"))
                            {
                                string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                {
                                    rPhaseCurrent += rBranchCurrent;
                                }
                            }
                            else if (spnPhase == "Y" && outConnector.CurrentValues.ContainsKey("Y_Current"))
                            {
                                string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                {
                                    yPhaseCurrent += yBranchCurrent;
                                }
                            }
                            else if (spnPhase == "B" && outConnector.CurrentValues.ContainsKey("B_Current"))
                            {
                                string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                {
                                    bPhaseCurrent += bBranchCurrent;
                                }
                            }
                        }
                    }
                    else if (targetItem.Name != null && targetItem.Name == "Busbar Chamber")
                    {
                        // Busbar Chamber phase/voltage logic:
                        // - 2-bar: single-phase system, all outgoing inherit incomer phase (R/Y/B), 230V
                        // - 4-bar: outgoing phase per configuration (R/Y/B => 230V, ALL => 415V)
                        string bars = "4";
                        if (targetItem.Properties != null && targetItem.Properties.Any())
                        {
                            bars = targetItem.Properties.First().GetValueOrDefault("Bars", "4") ?? "4";
                        }

                        foreach (var outConnector in outgoingConnectors)
                        {
                            string outKey = outConnector.SourcePointKey ?? "";
                            int outIndex = -1;
                            if (outKey.StartsWith("out", StringComparison.OrdinalIgnoreCase))
                            {
                                // Accept keys like out1 or out1_R etc.
                                var indexPart = outKey.Substring(3).Split('_')[0];
                                if (int.TryParse(indexPart, out int parsedIdx))
                                {
                                    outIndex = parsedIdx - 1;
                                }
                            }

                            float linkVoltage = 415f;
                            string linkPhase = "ALL";

                            if (string.Equals(bars, "2", StringComparison.OrdinalIgnoreCase))
                            {
                                linkVoltage = 230f;
                                linkPhase = phase;
                                if (linkPhase != "R" && linkPhase != "Y" && linkPhase != "B")
                                {
                                    linkPhase = "R";
                                }
                            }
                            else
                            {
                                string configuredPhase = "";
                                if (outIndex >= 0 && targetItem.Outgoing != null && outIndex < targetItem.Outgoing.Count)
                                {
                                    configuredPhase = targetItem.Outgoing[outIndex].GetValueOrDefault("Phase", "") ?? "";
                                }

                                // Default to round-robin if not configured
                                if (string.IsNullOrWhiteSpace(configuredPhase))
                                {
                                    var defaultPhases = new[] { "R", "Y", "B" };
                                    configuredPhase = defaultPhases[Math.Max(outIndex, 0) % 3];
                                }

                                if (string.Equals(configuredPhase, "ALL", StringComparison.OrdinalIgnoreCase))
                                {
                                    linkVoltage = 415f;
                                    linkPhase = "ALL";
                                }
                                else
                                {
                                    linkVoltage = 230f;
                                    if (string.Equals(configuredPhase, "Y", StringComparison.OrdinalIgnoreCase)) linkPhase = "Y";
                                    else if (string.Equals(configuredPhase, "B", StringComparison.OrdinalIgnoreCase)) linkPhase = "B";
                                    else linkPhase = "R";
                                }
                            }

                            TraceAndCalculateCurrent(outConnector, linkVoltage, phaseType, linkPhase, visited);

                            if (outConnector.CurrentValues.ContainsKey("Current"))
                            {
                                string currentStr = outConnector.CurrentValues["Current"];
                                if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                {
                                    totalCurrent += branchCurrent;
                                }
                            }

                            if (outConnector.CurrentValues.ContainsKey("R_Current"))
                            {
                                string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                    rPhaseCurrent += rBranchCurrent;
                            }

                            if (outConnector.CurrentValues.ContainsKey("Y_Current"))
                            {
                                string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                    yPhaseCurrent += yBranchCurrent;
                            }

                            if (outConnector.CurrentValues.ContainsKey("B_Current"))
                            {
                                string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                    bPhaseCurrent += bBranchCurrent;
                            }
                        }
                    }
                    else if (targetItem.Name != null && targetItem.Name.Contains("HTPN"))
                    {
                        // For HTPN DB, each outgoing connection has its own phase based on the connection point
                        foreach (var outConnector in outgoingConnectors)
                        {
                            // Determine phase based on the connection point key
                            string outPointKey = outConnector.SourcePointKey;
                            string outPhase = "R"; // Default
                            
                            if (outPointKey.Contains("R") || outPointKey.StartsWith("R"))
                                outPhase = "R";
                            else if (outPointKey.Contains("Y") || outPointKey.StartsWith("Y"))
                                outPhase = "Y";
                            else if (outPointKey.Contains("B") || outPointKey.StartsWith("B"))
                                outPhase = "B";
                            
                            // Pass the specific phase to this outgoing connection
                            TraceAndCalculateCurrent(outConnector, 230f, phaseType, outPhase, visited);
                            
                            // Add current from this branch
                            if (outConnector.CurrentValues.ContainsKey("Current"))
                            {
                                string currentStr = outConnector.CurrentValues["Current"];
                                if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                {
                                    totalCurrent += branchCurrent;
                                }
                            }
                            
                            // Add phase-specific currents
                            if (outConnector.CurrentValues.ContainsKey("R_Current"))
                            {
                                string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                {
                                    rPhaseCurrent += rBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("Y_Current"))
                            {
                                string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                {
                                    yPhaseCurrent += yBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("B_Current"))
                            {
                                string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                {
                                    bPhaseCurrent += bBranchCurrent;
                                }
                            }
                        }
                    }
                    // Handle Main Switch and Change Over Switch
                    else if (targetItem.Name != null && 
                            (targetItem.Name == "Main Switch" || targetItem.Name == "Change Over Switch"))
                    {
                        // Declare variables at the beginning of the block for scope
                        bool isSinglePhase = false;
                        string switchPhase = phase; // Inherit phase from incoming connection
                        float switchVoltage = currentVoltage;
                        
                        if (targetItem.Name == "Change Over Switch")
                        {
                            // Use the centralized handler for Change Over Switch
                            (switchVoltage, switchPhase) = ChangeOverSwitchHandler.DeterminePhaseAndVoltage(targetItem);
                            
                            // Determine if it's single phase
                            isSinglePhase = (switchVoltage == 230f);
                        }
                        else // Main Switch
                        {
                            // Check properties to determine phase type
                            if (targetItem.Properties != null && 
                                targetItem.Properties.Any() && 
                                targetItem.Properties.First().ContainsKey("Voltage"))
                            {
                                string voltageInfo = targetItem.Properties.First()["Voltage"];
                                if (voltageInfo.Contains("DP"))
                                {
                                    isSinglePhase = true;
                                    switchVoltage = 230f;
                                }
                                else
                                {
                                    // Three phase
                                    switchVoltage = 415f;
                                    switchPhase = "ALL";
                                }
                            }
                        }
                        
                        // Process outgoing connections
                        foreach (var outConnector in outgoingConnectors)
                        {
                            // Pass the appropriate voltage and phase
                            TraceAndCalculateCurrent(outConnector, switchVoltage, phaseType, switchPhase, visited);
                            
                            // Add current from this branch
                            if (outConnector.CurrentValues.ContainsKey("Current"))
                            {
                                string currentStr = outConnector.CurrentValues["Current"];
                                if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                {
                                    totalCurrent += branchCurrent;
                                }
                            }
                            
                            // Add phase-specific currents
                            if (outConnector.CurrentValues.ContainsKey("R_Current"))
                            {
                                string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                {
                                    rPhaseCurrent += rBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("Y_Current"))
                            {
                                string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                {
                                    yPhaseCurrent += yBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("B_Current"))
                            {
                                string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                {
                                    bPhaseCurrent += bBranchCurrent;
                                }
                            }
                        }
                    }
                    else
                    {
                        // Handle any other type of component not specifically handled above
                        // Pass the inherited phase to all outgoing connections
                        foreach (var outConnector in outgoingConnectors)
                        {
                            // Pass the phase to this outgoing connection
                            TraceAndCalculateCurrent(outConnector, currentVoltage, phaseType, phase, visited);
                            
                            // Add current from this branch
                            if (outConnector.CurrentValues.ContainsKey("Current"))
                            {
                                string currentStr = outConnector.CurrentValues["Current"];
                                if (float.TryParse(currentStr.Split(' ')[0], out float branchCurrent))
                                {
                                    totalCurrent += branchCurrent;
                                }
                            }
                            
                            // Add phase-specific currents
                            if (outConnector.CurrentValues.ContainsKey("R_Current"))
                            {
                                string rCurrentStr = outConnector.CurrentValues["R_Current"];
                                if (float.TryParse(rCurrentStr.Split(' ')[0], out float rBranchCurrent))
                                {
                                    rPhaseCurrent += rBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("Y_Current"))
                            {
                                string yCurrentStr = outConnector.CurrentValues["Y_Current"];
                                if (float.TryParse(yCurrentStr.Split(' ')[0], out float yBranchCurrent))
                                {
                                    yPhaseCurrent += yBranchCurrent;
                                }
                            }
                            
                            if (outConnector.CurrentValues.ContainsKey("B_Current"))
                            {
                                string bCurrentStr = outConnector.CurrentValues["B_Current"];
                                if (float.TryParse(bCurrentStr.Split(' ')[0], out float bBranchCurrent))
                                {
                                    bPhaseCurrent += bBranchCurrent;
                                }
                            }
                        }
                    }
                    
                    // Set current for this connector
                    connector.CurrentValues["Current"] = $"{totalCurrent:F2} A";
                    
                    // Set phase-specific currents
                    connector.CurrentValues["R_Current"] = $"{rPhaseCurrent:F2} A";
                    connector.CurrentValues["Y_Current"] = $"{yPhaseCurrent:F2} A";
                    connector.CurrentValues["B_Current"] = $"{bPhaseCurrent:F2} A";

                    // Calculate Voltage Drop
                    CalculateVoltageDropForConnector(connector, totalCurrent, currentVoltage);
                }
            }
        }

        private void CalculateVoltageDropForConnector(Connector connector, float current, float systemVoltage)
        {
            if (connector.Properties == null || !connector.Properties.Any() || connector.Length <= 0)
                return;

            try
            {
                // Extract properties
                string conductor = connector.Properties.ContainsKey("Material") ? connector.Properties["Material"] : 
                                  (connector.Properties.ContainsKey("Conductor") ? connector.Properties["Conductor"] : "Copper");
                
                string sizeStr = connector.Properties.ContainsKey("Size") ? connector.Properties["Size"] : "0";
                // Remove "sq.mm" or other suffixes if present
                sizeStr = new string(sizeStr.Where(c => char.IsDigit(c) || c == '.').ToArray());
                double size = double.TryParse(sizeStr, out double s) ? s : 0;

                string coreCategory = connector.Properties.ContainsKey("Core") ? connector.Properties["Core"] : "Twin Core";
                
                bool isWire = connector.MaterialType == "Wiring";

                if (size > 0)
                {
                    double voltageDrop = 0;
                    if (isWire)
                    {
                        voltageDrop = VoltageDropCalculator.CalculateWireVoltageDrop(conductor, size, current, connector.Length);
                    }
                    else
                    {
                        voltageDrop = VoltageDropCalculator.CalculateCableVoltageDrop(conductor, coreCategory, size, current, connector.Length);
                    }

                    connector.CurrentValues["VoltageDrop"] = $"{voltageDrop:F3} V";
                    
                    bool isCompliant = VoltageDropCalculator.CheckVoltageDropCompliance(
                        conductor, size, current, connector.Length, -1, systemVoltage, isWire, coreCategory);
                    
                    connector.CurrentValues["VoltageDropCompliant"] = isCompliant.ToString();
                    connector.CurrentValues["VoltageDropPercent"] = $"{(voltageDrop / systemVoltage * 100):F2}%";
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error calculating voltage drop: {ex.Message}");
            }
        }

        private string GetConnectorKey(Connector c)
        {
            var sId = c.SourceItem?.UniqueID.ToString() ?? "null";
            var tId = c.TargetItem?.UniqueID.ToString() ?? "null";
            var sKey = c.SourcePointKey ?? "";
            var tKey = c.TargetPointKey ?? "";
            return $"{sId}:{sKey}->{tId}:{tKey}";
        }
    }
}
