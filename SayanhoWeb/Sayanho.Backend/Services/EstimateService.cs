using OfficeOpenXml;
using OfficeOpenXml.Style;
using Sayanho.Core.Models;

namespace Sayanho.Backend.Services
{
    public class EstimateService
    {
        private class EstimateItem
        {
            public string SlNo { get; set; } = "";
            public string Description { get; set; } = "";
            public List<Subrow> Subrows { get; set; } = new();
        }

        private class Subrow
        {
            public string SlNo { get; set; } = "";
            public string DefaultValues { get; set; } = "";
            public double Quantity { get; set; }
            public string Unit { get; set; } = "";
            public double Rate { get; set; }
            public double Amount { get; set; }
        }

        public byte[] GenerateEstimate(List<CanvasSheet> sheets)
        {
            // Collect all items and connectors from all sheets
            var allItems = new List<CanvasItem>();
            var allConnectors = new List<Connector>();

            foreach (var sheet in sheets)
            {
                allItems.AddRange(sheet.CanvasItems);
                allConnectors.AddRange(sheet.StoredConnectors);
            }

            // Fix: Link connectors to items (Deserialization doesn't restore references automatically)
            // Use ToString() because UniqueID is Guid but connector IDs are strings
            var itemLookup = allItems.ToDictionary(i => i.UniqueID.ToString(), i => i, StringComparer.OrdinalIgnoreCase);
            foreach (var connector in allConnectors)
            {
                if (connector.SourceItem == null && !string.IsNullOrEmpty(connector.SourceItemId) && itemLookup.ContainsKey(connector.SourceItemId))
                {
                    connector.SourceItem = itemLookup[connector.SourceItemId];
                }
                if (connector.TargetItem == null && !string.IsNullOrEmpty(connector.TargetItemId) && itemLookup.ContainsKey(connector.TargetItemId))
                {
                    connector.TargetItem = itemLookup[connector.TargetItemId];
                }
            }

            if ((allItems == null || allItems.Count == 0) && (allConnectors == null || allConnectors.Count == 0))
            {
                throw new InvalidOperationException("No items or connectors to process.");
            }

            // Filter out Bulb, Source, and Portal items
            allItems = (allItems ?? new List<CanvasItem>()).Where(item =>
                item.Name != "Bulb" &&
                item.Name != "Tube Light" &&
                item.Name != "Ceiling Fan" &&
                item.Name != "Exhaust Fan" &&
                item.Name != "Split AC" &&
                item.Name != "AC Point" &&
                item.Name != "Geyser" &&
                item.Name != "Geyser Point" &&
                item.Name != "Call Bell" &&
                item.Name != "Source" &&
                item.Name != "Portal"
            ).ToList();

            // It's valid to continue even if there are no remaining items; connectors may still produce rows

            // Sort items according to predefined sequence
            var itemOrder = new Dictionary<string, (int Order, int Cols)>
            {
                { "Main Switch", (1, 4) },
                { "End box for TPN SFU", (2, 1) },
                { "Change Over Switch", (3, 4) },
                { "VTPN", (4, 4) },

                { "Busbar Chamber", (5, 2) },
                { "End box for Vertical TPN DB", (6, 4) }, // Shifted indices
                { "MCB", (7, 4) },
                { "MCCB", (8, 4) },
                { "SPN DB", (9, 4) },
                { "MCB Isolator", (10, 4) },
                { "HTPN", (11, 4) },
                { "End box for Horizontal TPN DB", (12, 4) },
                { "Cable", (13, 4) },
                { "Wiring", (13, 2) },
                { "Laying", (14, 1) },
                { "Compression Glands", (15, 3) },
                { "Finishing Cable Ends", (16, 3) },
                { "ACB", (17, 4) },
                { "Point Switch Board", (18, 2) },
                { "On Board", (19, 4) },
                { "Avg. 5A Switch Board", (20, 2) }
            };

            allItems = allItems.OrderBy(item =>
                itemOrder.ContainsKey(item.Name) ? itemOrder[item.Name].Order : 100
            ).ToList();

            ExcelPackage.LicenseContext = LicenseContext.NonCommercial;
            
            using (var package = new ExcelPackage())
            {
                var ws = package.Workbook.Worksheets.Add("Estimate");
                var headerRow = new[] { "Sl.No", "Description of Item", "Qty", "Unit", "Rate", "Amount" };
                ws.Cells[1, 1].LoadFromArrays(new[] { headerRow });

                // Set borders for header row
                var thinBorder = ws.Cells[1, 1, 1, 6].Style.Border;
                thinBorder.Bottom.Style = thinBorder.Top.Style = thinBorder.Left.Style = thinBorder.Right.Style = ExcelBorderStyle.Thin;

                // Set font to bold for the header row
                for (int i = 1; i <= 6; i++)
                {
                    ws.Cells[1, i].Style.Font.Bold = true;
                }

                double slNoMain = 1.00;
                double totalAmount = 0;
                var data = new List<EstimateItem>();

                // Calculation method (nested function)
                void Calculation(string itemname, Dictionary<string, string> dataItem, int condition,
                    string alternativeCompany1 = "", string alternativeCompany2 = "",
                    float cableLength = -1, int points = -1, int numberofcolumn = -1)
                {
                    // Determine columns from dictionary if not explicitly provided
                    int actualColumns = numberofcolumn != -1 ? numberofcolumn : (itemOrder.ContainsKey(itemname) ? itemOrder[itemname].Cols : 4);

                    string description = dataItem["Description"];
                    
                    // Take data up to GS
                    var defaultValues = new Dictionary<string, string>();
                    foreach (var kvp in dataItem)
                    {
                        if (kvp.Key == "Rate" || kvp.Key == "Description") continue;
                        defaultValues[kvp.Key] = kvp.Value;
                        if (kvp.Key == "GS") break;
                    }

                    double rate = Convert.ToDouble(dataItem["Rate"]);

                    var subKeys = defaultValues.Keys.TakeLast(actualColumns).ToList();
                    var subKeysValues = subKeys.ToDictionary(k => k, k => defaultValues[k]);

                    // Ensure uniqueness for Company values
                    var companyValues = new List<string>
                    {
                        defaultValues.ContainsKey("Company") ? defaultValues["Company"] : "",
                        alternativeCompany1,
                        alternativeCompany2
                    }
                    .Where(x => !string.IsNullOrEmpty(x))
                    .Distinct()
                    .ToList();

                    string defaultValuesStr = string.Join(", ", subKeysValues.Select(kvp =>
                        kvp.Key == "Company" ? $"(Make - {string.Join(" / ", companyValues)})" :
                        kvp.Key == "GS" ? $"[Ref: - {kvp.Value}]" : kvp.Value));

                    var existingDescription = data.FirstOrDefault(entry => entry.Description == description);

                    if (existingDescription != null)
                    {
                        // Find existing subrow or add new one
                        var existingSubrow = existingDescription.Subrows.FirstOrDefault(subrow =>
                        {
                            // Logic to match subrows (simplified)
                            return subrow.DefaultValues == defaultValuesStr;
                        });

                        if (existingSubrow != null)
                        {
                            // Update quantity
                            if (cableLength > -1)
                                existingSubrow.Quantity += cableLength;
                            else if (points > -1)
                                existingSubrow.Quantity += points;
                            else
                                existingSubrow.Quantity += 1;

                            existingSubrow.Amount = existingSubrow.Quantity * existingSubrow.Rate;
                        }
                        else
                        {
                            int subrowCount = existingDescription.Subrows.Count + 1;
                            double slNoSubrow = double.Parse(existingDescription.SlNo) + (subrowCount * 0.01);

                            string unit = DetermineUnit(itemname, cableLength, points);
                            double quantity = cableLength > -1 ? cableLength : (points > -1 ? points : 1);

                            existingDescription.Subrows.Add(new Subrow
                            {
                                SlNo = $"{slNoSubrow:F2}",
                                DefaultValues = defaultValuesStr,
                                Quantity = quantity,
                                Unit = unit,
                                Rate = rate,
                                Amount = rate * quantity
                            });
                        }
                    }
                    else
                    {
                        double slNoSubrow = slNoMain + 0.01;
                        string unit = DetermineUnit(itemname, cableLength, points);
                        double quantity = cableLength > -1 ? cableLength : (points > -1 ? points : 1);

                        data.Add(new EstimateItem
                        {
                            SlNo = $"{slNoMain:F2}",
                            Description = description,
                            Subrows = new List<Subrow>
                            {
                                new Subrow
                                {
                                    SlNo = $"{slNoSubrow:F2}",
                                    DefaultValues = defaultValuesStr,
                                    Quantity = quantity,
                                    Unit = unit,
                                    Rate = rate,
                                    Amount = rate * quantity
                                }
                            }
                        });
                        slNoMain += 1;
                    }
                }

                string DetermineUnit(string itemname, float cableLength, int points)
                {
                    if (cableLength > -1)
                        return cableLength <= 1 ? "Mtr" : "Mtrs";
                    else if (points > -1)
                        return itemname == "On Board" ? (points <= 1 ? "Point" : "Points") : (points <= 1 ? "No" : "Nos");
                    else
                        return "No";
                }

                // Process all canvas items
                foreach (var item in allItems)
                {
                    // Skip bulb, cubical panel, and source items
                    if (item.Name == "Bulb" || item.Name == "Source")
                        continue;

                    if (item.Properties == null || item.Properties.Count == 0)
                        continue;

                    var propertiesDictionary = item.Properties[0];

                    // Process different item types
                    if (item.Name == "Main Switch")
                    {
                        Calculation(item.Name, propertiesDictionary, 1, item.AlternativeCompany1, item.AlternativeCompany2);

                        // Check if Accessories exist and endbox_required is true
                        if (item.Accessories != null && item.Accessories.Count > 0)
                        {
                            var options = item.Accessories[0];
                            if (options.ContainsKey("endbox_required") && 
                                string.Equals(options["endbox_required"], "true", StringComparison.OrdinalIgnoreCase) &&
                                options.ContainsKey("number_of_endbox"))
                            {
                                int numberOfEndbox = int.Parse(options["number_of_endbox"]);
                                string endboxType = "End box for TPN SFU";

                                // Auto-fetch properties if missing (Frontend only sends config)
                                if (item.Accessories.Count < 2)
                                {
                                    try 
                                    {
                                        var dbResult = Sayanho.Core.Logic.DatabaseLoader.LoadDefaultPropertiesFromDatabase(endboxType, 2);
                                        
                                        // Filter based on Main Switch properties (Current Rating, Type, Enclosure)
                                        var currentRating = propertiesDictionary.ContainsKey("Current Rating") ? propertiesDictionary["Current Rating"] : "";
                                        var enclosure = propertiesDictionary.ContainsKey("Enclosure") ? propertiesDictionary["Enclosure"] : "";
                                        
                                        var endboxProps = dbResult.Properties.FirstOrDefault(row => 
                                            (row.ContainsKey("Current Rating") && row["Current Rating"].Trim().Equals(currentRating.Trim(), StringComparison.OrdinalIgnoreCase)) &&
                                            (row.ContainsKey("Enclosure") && row["Enclosure"].Trim().Equals(enclosure.Trim(), StringComparison.OrdinalIgnoreCase))
                                        );
                                            
                                        if (endboxProps != null)
                                        {
                                            item.Accessories.Add(endboxProps);
                                        }
                                        else
                                        {
                                            Console.WriteLine($"[ESTIMATE] Could not find properties for {endboxType} with Rating={currentRating}, Enclosure={enclosure}");
                                        }
                                    }
                                    catch (Exception ex)
                                    {
                                        Console.WriteLine($"[ESTIMATE] Error fetching properties for {endboxType}: {ex.Message}");
                                    }
                                }

                                if (item.Accessories.Count > 1)
                                {
                                    var endboxData = item.Accessories[1];
                                    Calculation(endboxType, endboxData, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, numberOfEndbox);
                                }
                            }
                        }
                    }
                    else if (item.Name == "Point Switch Board")
                    {
                        int points = allConnectors.Count(c => c.SourceItem != null && c.SourceItem.UniqueID == item.UniqueID);
                        if (points > 0)
                        {
                            Calculation(item.Name, propertiesDictionary, 1,
                                item.AlternativeCompany1, item.AlternativeCompany2, -1, points);

                            // Check if Accessories exist and orboard_required is true
                            if (item.Accessories != null && item.Accessories.Count > 0)
                            {
                                var options = item.Accessories[0];
                                if (options.ContainsKey("orboard_required") && 
                                    string.Equals(options["orboard_required"], "true", StringComparison.OrdinalIgnoreCase) &&
                                    options.ContainsKey("number_of_onboard"))
                                {
                                    int numberOfOnboard = int.Parse(options["number_of_onboard"]);
                                    if (item.Accessories.Count > 1)
                                    {
                                        var onboardData = item.Accessories[1];
                                        Calculation("On Board", onboardData, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, numberOfOnboard);
                                    }
                                }
                            }
                        }
                    }
                    else if (item.Name == "LT Cubical Panel")
                    {
                        int count = 0;
                        // 1. Process Incomers
                        if (propertiesDictionary.ContainsKey("Incomer Count"))
                        {
                            int.TryParse(propertiesDictionary["Incomer Count"], out count);

                            for (int i = 1; i <= count; i++)
                            {
                                string prefix = $"Incomer{i}_";
                                // Ensure we have a valid type selected
                                if (propertiesDictionary.ContainsKey($"{prefix}Type") && !string.IsNullOrEmpty(propertiesDictionary[$"{prefix}Type"]))
                                {
                                    string type = propertiesDictionary[$"{prefix}Type"];
                                    // Construct a temporary dictionary for this device
                                    var deviceProps = new Dictionary<string, string>();

                                    // Map specific fields (stripping prefix)
                                    if (propertiesDictionary.ContainsKey($"{prefix}Rate")) deviceProps["Rate"] = propertiesDictionary[$"{prefix}Rate"];
                                    if (propertiesDictionary.ContainsKey($"{prefix}Description")) deviceProps["Description"] = propertiesDictionary[$"{prefix}Description"];

                                    if (propertiesDictionary.ContainsKey($"{prefix}Rating"))
                                        deviceProps["Current Rating"] = propertiesDictionary[$"{prefix}Rating"];

                                    string pole = propertiesDictionary.ContainsKey($"{prefix}Pole") ? propertiesDictionary[$"{prefix}Pole"] : string.Empty;
                                    if (string.IsNullOrWhiteSpace(pole))
                                    {
                                        if (type == "Main Switch Open") pole = "TPN";
                                        else if (type.Contains("Change Over Switch")) pole = "FP";
                                    }
                                    if (!string.IsNullOrWhiteSpace(pole)) deviceProps["Pole"] = pole;

                                    if (propertiesDictionary.ContainsKey($"{prefix}Company"))
                                        deviceProps["Company"] = propertiesDictionary[$"{prefix}Company"];

                                    if (propertiesDictionary.ContainsKey($"{prefix}GS"))
                                        deviceProps["GS"] = propertiesDictionary[$"{prefix}GS"];

                                    // Only calculate if we valid data
                                    if (deviceProps.ContainsKey("Rate") && deviceProps.ContainsKey("Description"))
                                    {
                                        Calculation(type, deviceProps, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                                    }
                                }
                            }
                        }





                        // 1.5 Process Bus Couplers
                        for (int i = 1; i < count; i++)
                        {
                            string prefix = $"BusCoupler{i}_";
                            if (propertiesDictionary.ContainsKey($"{prefix}Type"))
                            {
                                string type = propertiesDictionary[$"{prefix}Type"];
                                if (type != "None" && type != "Direct" && !string.IsNullOrEmpty(type))
                                {
                                    var deviceProps = new Dictionary<string, string>();
                                    if (propertiesDictionary.ContainsKey($"{prefix}Rate")) deviceProps["Rate"] = propertiesDictionary[$"{prefix}Rate"];
                                    if (propertiesDictionary.ContainsKey($"{prefix}Description")) deviceProps["Description"] = propertiesDictionary[$"{prefix}Description"];

                                    if (propertiesDictionary.ContainsKey($"{prefix}Rating"))
                                        deviceProps["Current Rating"] = propertiesDictionary[$"{prefix}Rating"];

                                    string pole = propertiesDictionary.ContainsKey($"{prefix}Pole") ? propertiesDictionary[$"{prefix}Pole"] : string.Empty;
                                    if (string.IsNullOrWhiteSpace(pole) && type.Contains("Change Over Switch")) pole = "FP";
                                    if (!string.IsNullOrWhiteSpace(pole)) deviceProps["Pole"] = pole;

                                    if (propertiesDictionary.ContainsKey($"{prefix}Company"))
                                        deviceProps["Company"] = propertiesDictionary[$"{prefix}Company"];

                                    if (propertiesDictionary.ContainsKey($"{prefix}GS"))
                                        deviceProps["GS"] = propertiesDictionary[$"{prefix}GS"];

                                    if (deviceProps.ContainsKey("Rate") && deviceProps.ContainsKey("Description"))
                                    {
                                        Calculation("Bus Coupler (" + type + ")", deviceProps, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                                    }
                                }
                            }
                        }

                        // 2. Process Outgoings
                        if (item.Outgoing != null)
                        {
                            foreach (var outItem in item.Outgoing)
                            {
                                if (outItem.ContainsKey("Type") && outItem.ContainsKey("Rate") && outItem.ContainsKey("Description"))
                                {
                                    if (outItem.ContainsKey("Section"))
                                    {
                                        var secStr = outItem["Section"];
                                        if (int.TryParse(secStr, out int sec))
                                        {
                                            if (sec < 1 || sec > count) continue;
                                        }
                                    }

                                    string type = outItem["Type"];
                                    var deviceProps = new Dictionary<string, string>();
                                    deviceProps["Rate"] = outItem["Rate"];
                                    deviceProps["Description"] = outItem["Description"];

                                    if (outItem.ContainsKey("Rating") && !string.IsNullOrWhiteSpace(outItem["Rating"]))
                                        deviceProps["Current Rating"] = outItem["Rating"];
                                    else if (outItem.ContainsKey("Current Rating") && !string.IsNullOrWhiteSpace(outItem["Current Rating"]))
                                        deviceProps["Current Rating"] = outItem["Current Rating"];

                                    string pole = outItem.ContainsKey("Pole") ? outItem["Pole"] : string.Empty;
                                    if (string.IsNullOrWhiteSpace(pole) && type == "Main Switch Open") pole = "TPN";
                                    if (string.IsNullOrWhiteSpace(pole) && type.Contains("Change Over Switch")) pole = "FP";
                                    if (!string.IsNullOrWhiteSpace(pole)) deviceProps["Pole"] = pole;

                                    if (outItem.ContainsKey("Company") && !string.IsNullOrWhiteSpace(outItem["Company"]))
                                        deviceProps["Company"] = outItem["Company"];

                                    if (outItem.ContainsKey("GS") && !string.IsNullOrWhiteSpace(outItem["GS"]))
                                        deviceProps["GS"] = outItem["GS"];

                                    Calculation(type, deviceProps, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                                }
                            }
                        }
                    }
                    else if (item.Name == "Busbar Chamber")
                    {
                        // Check for Length property
                         float length = 1;
                         if (propertiesDictionary.ContainsKey("Length") && float.TryParse(propertiesDictionary["Length"], out float l))
                         {
                             length = l;
                         }
                         
                         // Pass length as cableLength argument to force Unit = "Mtr" in DetermineUnit
                         // and Quantity = length in logic
                         Calculation(item.Name, propertiesDictionary, 1, 
                             item.AlternativeCompany1, item.AlternativeCompany2, cableLength: length);
                    }
                    else
                    {
                        Calculation(item.Name, propertiesDictionary, 1,
                            item.AlternativeCompany1, item.AlternativeCompany2);
                    }

                    if (item.Name == "VTPN" || item.Name == "HTPN")
                    {
                        // Check if Accessories exist and endbox_required is true
                        if (item.Accessories != null && item.Accessories.Count > 0)
                        {
                            var options = item.Accessories[0];
                            if (options.ContainsKey("endbox_required") && 
                                string.Equals(options["endbox_required"], "true", StringComparison.OrdinalIgnoreCase) &&
                                options.ContainsKey("number_of_endbox"))
                            {
                                int numberOfEndbox = int.Parse(options["number_of_endbox"]);
                                string endboxType = item.Name == "VTPN" ? "End box for Vertical TPN DB" : "End box for Horizontal TPN DB";

                                // Auto-fetch properties if missing (Frontend only sends config)
                                if (item.Accessories.Count < 2)
                                {
                                    try 
                                    {
                                        var dbResult = Sayanho.Core.Logic.DatabaseLoader.LoadDefaultPropertiesFromDatabase(endboxType, 2);
                                        var way = propertiesDictionary.ContainsKey("Way") ? propertiesDictionary["Way"] : "";
                                        
                                        // Robust matching for Way property (digits only)
                                        string GetDigits(string s) => new string(s.Where(char.IsDigit).ToArray());
                                        var targetWayDigits = GetDigits(way);

                                        var endboxProps = dbResult.Properties.FirstOrDefault(row => 
                                        {
                                            if (!row.ContainsKey("Way")) return false;
                                            var dbWayDigits = GetDigits(row["Way"]);
                                            return dbWayDigits == targetWayDigits;
                                        });
                                            
                                        if (endboxProps != null)
                                        {
                                            item.Accessories.Add(endboxProps);
                                        }
                                        else
                                        {
                                            Console.WriteLine($"[ESTIMATE] Could not find properties for {endboxType} with Way={way}");
                                        }
                                    }
                                    catch (Exception ex)
                                    {
                                        Console.WriteLine($"[ESTIMATE] Error fetching properties for {endboxType}: {ex.Message}");
                                    }
                                }

                                if (item.Accessories.Count > 1)
                                {
                                    var endboxData = item.Accessories[1];
                                    Calculation(endboxType, endboxData, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, numberOfEndbox);
                                }
                            }
                        }
                    }

                    if (item.Name == "VTPN" || item.Name == "SPN DB" || item.Name == "HTPN")
                    {
                        // Check if Incomer exists
                        if (item.Incomer != null && item.Incomer.Count > 0)
                        {
                            string incomerName = item.Name == "VTPN" ? "MCCB" : (item.Name == "SPN DB" ? "MCB Isolator" : "MCB");
                            Calculation(incomerName, item.Incomer, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                        }

                        var outgoings = item.Outgoing;
                        if (outgoings != null)
                        {
                            foreach (var banch in outgoings)
                            {
                                Calculation("MCB", banch, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                            }
                        }
                    }
                }

                // Process connectors (cables and laying)
                foreach (var connector in allConnectors)
                {
                    // Skip mirrored/virtual connectors and any connectors attached to an IN portal at either end
                    try
                    {
                        if (connector.IsVirtual)
                        {
                            continue;
                        }

                        bool endIsInPortal(CanvasItem? item)
                        {
                            if (item == null || item.Name != "Portal") return false;
                            var p = item.Properties?.FirstOrDefault();
                            var d = p != null && p.ContainsKey("Direction") ? p["Direction"] : "";
                            return string.Equals(d, "in", StringComparison.OrdinalIgnoreCase);
                        }

                        if (endIsInPortal(connector.SourceItem) || endIsInPortal(connector.TargetItem))
                        {
                            continue;
                        }
                    }
                    catch { /* safe guard */ }

                    float cableLength = connector.Length;
                    
                    // BUGFIX: Check if Length is stored in Properties instead of the Length field
                    if (cableLength == 0 && connector.Properties != null && connector.Properties.ContainsKey("Length"))
                    {
                        if (float.TryParse(connector.Properties["Length"], out float lengthFromProps))
                        {
                            cableLength = lengthFromProps;
                        }
                        connector.Properties.Remove("Length");
                    }
                    
                    if (cableLength > 0)
                    {
                        // Process cable properties
                        if (connector.Properties != null && connector.Properties.Count > 0)
                        {
                            string materialType = connector.MaterialType ?? "Cable";
                            Calculation(materialType, connector.Properties, 1,
                                connector.AlternativeCompany1, connector.AlternativeCompany2, cableLength);

                            // Check if Accessories exist and glands_required is true
                            if (connector.Accessories != null && connector.Accessories.Count > 0)
                            {
                                var options = connector.Accessories[0];
                                if (options.ContainsKey("glands_required") && 
                                    string.Equals(options["glands_required"], "true", StringComparison.OrdinalIgnoreCase) &&
                                    options.ContainsKey("number_of_glands"))
                                {
                                    int numberOfGlands = int.Parse(options["number_of_glands"]);
                                    
                                    // Auto-fetch properties if missing (Frontend only sends config)
                                    if (connector.Accessories.Count < 2)
                                    {
                                        try 
                                        {
                                            var dbResult = Sayanho.Core.Logic.DatabaseLoader.LoadDefaultPropertiesFromDatabase("Compression Glands", 2);
                                            
                                            // Filter based on Cable properties (Core, Size)
                                            var core = connector.Properties.ContainsKey("Core") ? connector.Properties["Core"] : "";
                                            var size = connector.Properties.ContainsKey("Size") ? connector.Properties["Size"] : "";
                                            
                                            var glandsProps = dbResult.Properties.FirstOrDefault(row => 
                                                (row.ContainsKey("Core") && row["Core"].Trim().Equals(core.Trim(), StringComparison.OrdinalIgnoreCase)) &&
                                                (row.ContainsKey("Size") && row["Size"].Trim().Equals(size.Trim(), StringComparison.OrdinalIgnoreCase))
                                            );
                                                
                                            if (glandsProps != null)
                                            {
                                                Console.WriteLine($"[ESTIMATE] Auto-fetched properties for Compression Glands");
                                                connector.Accessories.Add(glandsProps);
                                            }
                                            else
                                            {
                                                Console.WriteLine($"[ESTIMATE] Could not find properties for Compression Glands with Core={core}, Size={size}");
                                            }
                                        }
                                        catch (Exception ex)
                                        {
                                            Console.WriteLine($"[ESTIMATE] Error fetching properties for Compression Glands: {ex.Message}");
                                        }
                                    }

                                    if (connector.Accessories.Count > 1)
                                    {
                                        var glandsData = connector.Accessories[1];
                                        Calculation("Compression Glands", glandsData, 1, connector.AlternativeCompany1, connector.AlternativeCompany2, -1, numberOfGlands);
                                    }
                                }
                            }
                        }

                            // Check if Accessories exist and finishing_required is true
                            if (connector.Accessories != null && connector.Accessories.Count > 0)
                            {
                                var options = connector.Accessories[0];
                                if (options.ContainsKey("finishing_required") && 
                                    string.Equals(options["finishing_required"], "true", StringComparison.OrdinalIgnoreCase) &&
                                    options.ContainsKey("number_of_finishing") && options.ContainsKey("finishing_method"))
                                {
                                    int numberOfFinishing = int.Parse(options["number_of_finishing"]);
                                    string method = options["finishing_method"]; // Soldering vs Crimping
                                    
                                    try 
                                    {
                                        var dbResult = Sayanho.Core.Logic.DatabaseLoader.LoadDefaultPropertiesFromDatabase("Finishing Cable Ends", 20); // Fetch enough rows to find match
                                        
                                        // Filter based on Cable properties (Core, Size) AND Method
                                        var core = connector.Properties.ContainsKey("Core") ? connector.Properties["Core"] : "";
                                        var size = connector.Properties.ContainsKey("Size") ? connector.Properties["Size"] : "";
                                        
                                        // Normalize strings for comparison
                                        core = core.Trim();
                                        size = size.Trim();
                                        method = method.Trim();

                                        var finishingProps = dbResult.Properties.FirstOrDefault(row => 
                                            (row.ContainsKey("Method") && row["Method"].Trim().Equals(method, StringComparison.OrdinalIgnoreCase)) &&
                                            (row.ContainsKey("Core") && row["Core"].Trim().Equals(core, StringComparison.OrdinalIgnoreCase)) &&
                                            (row.ContainsKey("Size") && row["Size"].Trim().Equals(size, StringComparison.OrdinalIgnoreCase))
                                        );
                                            
                                        if (finishingProps != null)
                                        {
                                            Calculation("Finishing Cable Ends", finishingProps, 1, connector.AlternativeCompany1, connector.AlternativeCompany2, -1, numberOfFinishing);
                                        }
                                        else
                                        {
                                            Console.WriteLine($"[ESTIMATE] Could not find properties for Finishing Cable Ends with Method={method}, Core={core}, Size={size}");
                                        }
                                    }
                                    catch (Exception ex)
                                    {
                                        Console.WriteLine($"[ESTIMATE] Error fetching properties for Finishing Cable Ends: {ex.Message}");
                                    }
                                }
                            }

                        
                        // Process laying properties (only for cables, not for wiring connections)
                        if (connector.Laying != null && connector.Laying.Count > 0 && connector.MaterialType != "Wiring")
                        {
                            Calculation("Laying", connector.Laying, 1, "", "", cableLength, -1); // Laying defaults to 1 col from dictionary
                        }
                    }
                }

                // Write data to worksheet
                int currentRow = 2;
                foreach (var item in data)
                {
                    if (item.Subrows.Count == 1)
                    {
                        var subrow = item.Subrows[0];
                        totalAmount += subrow.Amount;

                        ws.Cells[currentRow, 1].Value = item.SlNo;
                        ws.Cells[currentRow, 2].Value = item.Description + " - " + subrow.DefaultValues;
                        ws.Cells[currentRow, 3].Value = subrow.Quantity;
                        ws.Cells[currentRow, 4].Value = subrow.Unit;
                        ws.Cells[currentRow, 5].Value = subrow.Rate;
                        ws.Cells[currentRow, 6].Formula = $"C{currentRow}*E{currentRow}";
                        currentRow++;
                    }
                    else
                    {
                        ws.Cells[currentRow, 1].Value = item.SlNo;
                        ws.Cells[currentRow, 2].Value = item.Description;
                        currentRow++;

                        foreach (var subrow in item.Subrows)
                        {
                            totalAmount += subrow.Amount;

                            ws.Cells[currentRow, 1].Value = subrow.SlNo;
                            ws.Cells[currentRow, 2].Value = subrow.DefaultValues;
                            ws.Cells[currentRow, 3].Value = subrow.Quantity;
                            ws.Cells[currentRow, 4].Value = subrow.Unit;
                            ws.Cells[currentRow, 5].Value = subrow.Rate;
                            ws.Cells[currentRow, 6].Formula = $"C{currentRow}*E{currentRow}";
                            currentRow++;
                        }
                    }
                }

                // Format cells and set column widths
                for (int rowIndex = 1; rowIndex <= currentRow - 1; rowIndex++)
                {
                    for (int colIndex = 1; colIndex <= 6; colIndex++)
                    {
                        var cell = ws.Cells[rowIndex, colIndex];
                        cell.Style.Border.Bottom.Style = ExcelBorderStyle.Thin;
                        cell.Style.Border.Top.Style = ExcelBorderStyle.Thin;
                        cell.Style.Border.Left.Style = ExcelBorderStyle.Thin;
                        cell.Style.Border.Right.Style = ExcelBorderStyle.Thin;
                        cell.Style.VerticalAlignment = ExcelVerticalAlignment.Top;

                        if (colIndex == 2)
                            cell.Style.WrapText = true;
                    }
                }

                // Set column widths
                ws.Column(1).Width = 8;
                ws.Column(2).Width = 75;
                ws.Column(3).Width = 10;
                ws.Column(4).Width = 10;
                ws.Column(5).Width = 15;
                ws.Column(6).Width = 20;

                // Add total row
                int totalRow = currentRow;
                ws.Cells[totalRow, 3, totalRow, 5].Merge = true;
                ws.Cells[totalRow, 3].Value = "Total Amount : Rs ";
                ws.Cells[totalRow, 3].Style.HorizontalAlignment = ExcelHorizontalAlignment.Center;
                ws.Cells[totalRow, 6].Formula = $"SUM(F2:F{totalRow - 1})";

                // Return Excel file as byte array
                return package.GetAsByteArray();
            }
        }
    }
}
