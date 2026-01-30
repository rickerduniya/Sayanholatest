using OfficeOpenXml;
using OfficeOpenXml.Style;
using Sayanho.Core.Models;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Sayanho.Core.Logic
{
    public class EstimateItem
    {
        public string SlNo { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
        public List<Subrow> Subrows { get; set; } = new List<Subrow>();
    }

    public class Subrow
    {
        public string SlNo { get; set; } = string.Empty;
        public string DefaultValues { get; set; } = string.Empty;
        public double Quantity { get; set; }
        public string Unit { get; set; } = string.Empty;
        public double Rate { get; set; }
        public double Amount { get; set; }
    }

    public class EstimateGenerator
    {
        public byte[] GenerateEstimate(List<CanvasItem> canvasItems, List<Connector> connectors)
        {
            if ((canvasItems == null || canvasItems.Count == 0) && (connectors == null || connectors.Count == 0))
            {
                throw new ArgumentException("No items or connectors to process.");
            }

            // Filter out Bulb, Source, and Portal items
            canvasItems = (canvasItems ?? new List<CanvasItem>()).Where(item => 
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

            // It's valid to continue even if there are no remaining items; cables/laying
            // from connectors may still produce estimate lines.
            
            // Sort items according to the sequence in Schedule_encrypted.xlsx index sheet
            Dictionary<string, int> itemOrder = new Dictionary<string, int>
            {
                { "Main Switch", 1 },
                {"End box for TPN SFU",2},
                { "Change Over Switch", 3 },
                { "VTPN", 4 },
                {"End box for Vertical TPN DB",5},
                { "MCB", 6 },
                { "MCCB", 7 },
                { "SPN DB", 8 },
                { "MCB Isolator", 9 },
                { "HTPN", 10 },
                {"End box for Horizontal TPN DB",11},
                {"Cable",12},
                {"Wiring",12}, // Same order as Cable since they're both conducting materials
                {"Laying",13},
                {"Compression Glands",14},
                // Cable and Laying are processed separately
                { "ACB", 15 },
                { "Point Switch Board", 16 },
                { "On Board", 17 },
                { "Avg. 5A Switch Board", 18 }
            };
            
            // Sort the canvas items based on the predefined order
            canvasItems = canvasItems.OrderBy(item => 
                itemOrder.ContainsKey(item.Name) ? itemOrder[item.Name] : 100 // Items not in the list go to the end
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

                void Calculation(string itemname, Dictionary<string, string> dataItem, int condition, string alternativeCompany1 = "", string alternativeCompany2 = "", float cableLength = -1, int points = -1, int numberofcolumn = 4)
                { 
                    string description;
                    double rate;

                    Dictionary<string, string> defaultValues;

                    description = dataItem.ContainsKey("Description") ? dataItem["Description"] : itemname;
                    defaultValues = dataItem.Where(kvp => kvp.Key != "Rate" && kvp.Key != "Description")
                                            .ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
                    rate = dataItem.ContainsKey("Rate") ? Convert.ToDouble(dataItem["Rate"]) : 0;

                    // For Point Switch Board items, only take the last 2 columns instead of 4
                    var subKeys = defaultValues.Keys.TakeLast(numberofcolumn).ToList();
                    
                    var subKeysValues = subKeys.ToDictionary(k => k, k => defaultValues[k]);

                    // Ensure uniqueness for Company, alternativeCompany1, and alternativeCompany2
                    var companyValues = new List<string>
                    {
                        defaultValues.ContainsKey("Company") ? defaultValues["Company"] : "",
                        alternativeCompany1,
                        alternativeCompany2
                    }
                    .Where(x => !string.IsNullOrEmpty(x)) // Remove empty values
                    .Distinct() // Ensure uniqueness
                    .ToList();
                    
                    string defaultValuesStr = string.Join(", ", subKeysValues.Select(kvp =>
                        kvp.Key == "Company" ? $"(Make - {string.Join(" / ", companyValues)})" :
                        kvp.Key == "GS" ? $"[Ref: - {kvp.Value}]" : kvp.Value));

                    var existingDescription = data.FirstOrDefault(entry => entry.Description == description);

                    if (existingDescription != null)
                    {
                        // Find a subrow with the same main properties (ignoring differences in alternative companies)
                        var existingSubrow = existingDescription.Subrows
                            .FirstOrDefault(subrow => 
                            {
                                // Extract main company from the subrow's DefaultValues
                                string mainCompany = "";
                                if (subrow.DefaultValues.Contains("(Make - "))
                                {
                                    int startIndex = subrow.DefaultValues.IndexOf("(Make - ") + 8;
                                    int endIndex = subrow.DefaultValues.IndexOf(")", startIndex);
                                    if (endIndex > startIndex)
                                    {
                                        string companiesSection = subrow.DefaultValues.Substring(startIndex, endIndex - startIndex);
                                        // Get the first company (main company) from the list
                                        mainCompany = companiesSection.Split('/')[0].Trim();
                                    }
                                }
                                
                                // Extract main company from the current item
                                string currentMainCompany = defaultValues.ContainsKey("Company") ? defaultValues["Company"] : "";
                                
                                // Compare other properties (excluding company details)
                                bool sameProperties = true;
                                foreach (var key in subKeysValues.Keys.Where(k => k != "Company"))
                                {
                                    if (subKeysValues.ContainsKey(key))
                                    {
                                        string expectedValue = key == "GS" ? $"[Ref: - {subKeysValues[key]}]" : subKeysValues[key];
                                        if (!subrow.DefaultValues.Contains(expectedValue))
                                        {
                                            sameProperties = false;
                                            break;
                                        }
                                    }
                                }

                                if (!subrow.DefaultValues.Contains("(Make - "))
                                {return sameProperties;}
                                
                                // Return true if main company and other properties match
                                return !string.IsNullOrEmpty(mainCompany) && 
                                       !string.IsNullOrEmpty(currentMainCompany) && 
                                       mainCompany.Equals(currentMainCompany, StringComparison.OrdinalIgnoreCase) &&
                                       sameProperties;
                            });

                        if (existingSubrow != null)
                        {
                            // Update quantity
                            if (cableLength > -1)
                                {existingSubrow.Quantity += cableLength;}
                            else if (points > -1)
                                {existingSubrow.Quantity += points;}
                            else
                                {existingSubrow.Quantity += 1;}
                            
                            // Update amount
                            existingSubrow.Amount = existingSubrow.Quantity * existingSubrow.Rate;
                            
                            // Update alternative companies list
                            if (!string.IsNullOrEmpty(alternativeCompany1) || !string.IsNullOrEmpty(alternativeCompany2))
                            {
                                // Extract current companies
                                string currentCompaniesSection = "";
                                if (existingSubrow.DefaultValues.Contains("(Make - "))
                                {
                                    int startIndex = existingSubrow.DefaultValues.IndexOf("(Make - ") + 8;
                                    int endIndex = existingSubrow.DefaultValues.IndexOf(")", startIndex);
                                    if (endIndex > startIndex)
                                    {
                                        currentCompaniesSection = existingSubrow.DefaultValues.Substring(startIndex, endIndex - startIndex);
                                        
                                        // Combine all companies
                                        var currentCompanies = currentCompaniesSection.Split('/').Select(c => c.Trim()).ToList();
                                        var allCompanies = new List<string>(currentCompanies);
                                        
                                        // Add main company if not already in the list
                                        string mainCompany = defaultValues.ContainsKey("Company") ? defaultValues["Company"] : "";
                                        if (!string.IsNullOrEmpty(mainCompany) && !currentCompanies.Contains(mainCompany))
                                            allCompanies.Add(mainCompany);
                                        
                                        // Add alternative companies if not already in the list
                                        if (!string.IsNullOrEmpty(alternativeCompany1) && !currentCompanies.Contains(alternativeCompany1))
                                            allCompanies.Add(alternativeCompany1);
                                            
                                        if (!string.IsNullOrEmpty(alternativeCompany2) && !currentCompanies.Contains(alternativeCompany2))
                                            allCompanies.Add(alternativeCompany2);
                                        
                                        // Create updated DefaultValues string
                                        string updatedCompaniesStr = string.Join(" / ", allCompanies.Distinct());
                                        existingSubrow.DefaultValues = existingSubrow.DefaultValues.Replace(
                                            $"(Make - {currentCompaniesSection})", 
                                            $"(Make - {updatedCompaniesStr})");
                                    }
                                }
                            }
                        }
                        else
                        {
                            int subrowCount = existingDescription.Subrows.Count + 1;
                            double slNoSubrow = double.Parse(existingDescription.SlNo) + (subrowCount * 0.01);
                            if (cableLength>-1){
                                existingDescription.Subrows.Add(new Subrow
                                {
                                    SlNo = $"{slNoSubrow:F2}",
                                    DefaultValues = defaultValuesStr,
                                    Quantity = cableLength, // Use cableLength
                                    Unit = cableLength <= 1 ? "Mtr" : "Mtrs",  // Singular or plural based on quantity
                                    Rate = rate,
                                    Amount = rate * cableLength
                                });}

                            else if (points>-1){
                                string unit = itemname == "On Board" ? (points <= 1 ? "Point" : "Points") : (points <= 1 ? "No" : "Nos");
                                existingDescription.Subrows.Add(new Subrow
                                {
                                    SlNo = $"{slNoSubrow:F2}",
                                    DefaultValues = defaultValuesStr,
                                    Quantity = points, 
                                    Unit = unit,
                                    Rate = rate,
                                    Amount = rate * points
                                });}
                                        
                            else {
                                existingDescription.Subrows.Add(new Subrow
                                        {
                                            SlNo = $"{slNoSubrow:F2}",
                                            DefaultValues = defaultValuesStr,
                                            Quantity = 1,
                                            Unit = "No",  // Singular form since quantity is 1
                                            Rate = rate,
                                            Amount = rate
                                        });}
                        }
                    }
                    else
                    {
                        double slNoSubrow = slNoMain + 0.01;
                        if (cableLength>-1)
                            {data.Add(new EstimateItem
                            {
                                SlNo = $"{slNoMain:F2}",
                                Description = description,
                                Subrows = new List<Subrow>
                                {
                                    new Subrow
                                    {
                                        SlNo = $"{slNoSubrow:F2}",
                                        DefaultValues = defaultValuesStr,
                                        Quantity = cableLength,
                                        Unit = cableLength <= 1 ? "Mtr" : "Mtrs",
                                        Rate = rate,
                                        Amount = rate * cableLength
                                    }
                                }
                            });}

                    else if (points>-1)
                            { string unit = itemname == "On Board" ? (points <= 1 ? "Point" : "Points") : (points <= 1 ? "No" : "Nos");
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
                                        Quantity = points,
                                        Unit = unit,
                                        Rate = rate,
                                        Amount = rate * points
                                    }
                                }
                            });}

                        else{                  
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
                                            Quantity = 1,
                                            Unit = "No",  // Always singular since quantity is 1
                                            Rate = rate,
                                            Amount = rate
                                        }
                                    }
                                });
                                }
                        slNoMain += 1;
                    }
                }

                foreach (var item in canvasItems)
                { 
                    // Skip bulb, cubical panel, and source items
                    if (item.Name == "Bulb" || item.Name == "Source")
                        continue;   
                    
                    // Check if Properties collection exists and has items before accessing
                    if (item.Properties == null || !item.Properties.Any())
                        continue;
                        
                    var propertiesDictionary = item.Properties.FirstOrDefault();

                    if (item.Name == "Main Switch")
                    {
                        Calculation(item.Name,propertiesDictionary, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                        
                        // Check if Accessories exist and endbox_required is true
                        if (item.Accessories != null && item.Accessories.Count > 0)
                        {
                            var options = item.Accessories[0];
                            if (options.ContainsKey("endbox_required") && options["endbox_required"] == "true" && 
                                options.ContainsKey("number_of_endbox"))
                            {
                                // Get the number of endboxes required
                                int numberOfEndbox = int.Parse(options["number_of_endbox"]);
                                
                                // Check if Cable end box data exists in Accessories
                                if (item.Accessories.Count > 1)
                                {
                                    var endboxData = item.Accessories[1];
                                                                    
                                    // Include Cable end box data in estimate with quantity as number_of_endbox
                                    Calculation("End box for TPN SFU",endboxData, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, numberOfEndbox, 1);
                                }
                            }
                        }
                        
                    }
                    else if (item.Name == "Point Switch Board")
                    {
                        // Count how many connectors have this item as source
                        int points = connectors.Count(c => c.SourceItem != null && c.SourceItem.UniqueID == item.UniqueID);
                        if (points>0)
                        {
                            Calculation(item.Name,propertiesDictionary, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, points, 2);
                        
                        // Check if Accessories exist and orboard_required is true
                        if (item.Accessories != null && item.Accessories.Count > 0)
                        {
                            var options = item.Accessories[0];
                            if (options.ContainsKey("orboard_required") && options["orboard_required"] == "true" && 
                                options.ContainsKey("number_of_onboard"))
                            {
                                // Get the number of onboards required
                                int numberOfOnboard = int.Parse(options["number_of_onboard"]);
                                
                                // Check if Onboard data exists in Accessories
                                if (item.Accessories.Count > 1)
                                {
                                    var onboardData = item.Accessories[1];
                                    // Include Onboard data in estimate with quantity as number_of_onboard
                                    Calculation("On Board",onboardData, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, numberOfOnboard, 2);
                                }
                            }
                        }
                        }
                    }
                    else 
                    {Calculation(item.Name,propertiesDictionary, 1, item.AlternativeCompany1, item.AlternativeCompany2);}
                    
                    if (item.Name == "VTPN" || item.Name == "HTPN")
                    {
                        // Check if Accessories exist and endbox_required is true for VTPN or HTPN
                        if (item.Accessories != null && item.Accessories.Count > 0)
                        {
                            var options = item.Accessories[0];
                            if (options.ContainsKey("endbox_required") && options["endbox_required"] == "true" && 
                                options.ContainsKey("number_of_endbox"))
                            {
                                // Get the number of endboxes required
                                int numberOfEndbox = int.Parse(options["number_of_endbox"]);
                                
                                // Check if End box data exists in Accessories
                                if (item.Accessories.Count > 1)
                                {
                                    var endboxData = item.Accessories[1];
                                    
                                    // Include appropriate End box data in estimate with quantity as number_of_endbox
                                    string endboxType = item.Name == "VTPN" ? "End box for Vertical TPN DB" : "End box for Horizontal TPN DB";
                                    Calculation(endboxType, endboxData, 1, item.AlternativeCompany1, item.AlternativeCompany2, -1, numberOfEndbox, 2);
                                }
                            }
                        }
                    }
                    
                    if (item.Name == "VTPN"||item.Name == "SPN DB"||item.Name == "HTPN")
                    { 
                        // Check if Incomer exists before processing
                        if (item.Incomer != null)
                            
                            Calculation(item.Name == "VTPN"?"MCCB":item.Name == "SPN DB"?"MCB Isolator":"MCB", item.Incomer, 1, item.AlternativeCompany1, item.AlternativeCompany2);
                            
                        var outgoings = item.Outgoing;
                        if (outgoings != null)
                        {
                            foreach (var banch in outgoings)
                            {
                                Calculation("MCB",banch, 1,item.AlternativeCompany1,item.AlternativeCompany2);
                            }
                        }
                    }
                }
                                // Process cables and laying
                foreach (var connector in connectors)
                {
                    // Skip connectors whose source is an IN portal (mirrored on target sheet)
                    try
                    {
                        if (connector.SourceItem != null && connector.SourceItem.Name == "Portal")
                        {
                            var props = connector.SourceItem.Properties?.FirstOrDefault();
                            var dir = props != null && props.ContainsKey("Direction") ? props["Direction"] : "";
                            if (string.Equals(dir, "in", StringComparison.OrdinalIgnoreCase))
                            {
                                continue;
                            }
                        }
                    }
                    catch { /* ignore */ }
                    float cableLength = connector.Length;  // Get cable length
                    if (cableLength > 0)
                    {

                    // Process cable properties
                    if (connector.Properties != null && connector.Properties.Any())
                    {                        

                        // Use the connector's MaterialType (Cable or Wiring)
                        string materialType = connector.MaterialType ?? "Cable";
                        Calculation(materialType, connector.Properties, 1, connector.AlternativeCompany1, connector.AlternativeCompany2, cableLength);
                        
                        // Check if Accessories exist and glands_required is true
                        if (connector.Accessories != null && connector.Accessories.Count > 0)
                        {
                            var options = connector.Accessories[0];
                            if (options.ContainsKey("glands_required") && options["glands_required"] == "true" && 
                                options.ContainsKey("number_of_glands"))
                            {
                                // Get the number of glands required
                                int numberOfGlands = int.Parse(options["number_of_glands"]);
                                
                                // Check if Compression Glands data exists in Accessories
                                if (connector.Accessories.Count > 1)
                                {
                                    var glandsData = connector.Accessories[1];
                                    
                                    // Include Compression Glands data in estimate with quantity as number_of_glands
                                    Calculation("Compression Glands", glandsData, 1, connector.AlternativeCompany1, connector.AlternativeCompany2, -1, numberOfGlands, 3);
                                }
                            }
                        }
                    }

                    // Process laying properties (only for cables, not for wiring connections)
                    if (connector.Laying != null && connector.Laying.Any() && connector.MaterialType != "Wiring")
                    {
                        Calculation("Laying",connector.Laying, 1, "", "", cableLength,-1,3);
                    }
                    }
                }
            
                // Write data to the worksheet
                int currentRow = 2; // Start from row 2 since row 1 is header
                for (int i = 0; i < data.Count; i++)
                {
                    var item = data[i];
                    
                    // Check if this item has only one subrow
                    if (item.Subrows.Count == 1)
                    {
                        // Combine the description and subrow into a single row
                        var subrow = item.Subrows[0];
                        double quantity = subrow.Quantity;
                        double rate = subrow.Rate;
                        
                        // Determine singular or plural form based on final quantity
                        string unit = subrow.Unit;
                        
                        // Update unit based on final quantity
                        if (unit.StartsWith("Mtr"))
                        {
                            unit = quantity <= 1 ? "Mtr" : "Mtrs";
                        }
                        else if (unit.StartsWith("Point"))
                        {
                            unit = quantity <= 1 ? "Point" : "Points";
                        }
                        else if (unit == "No")
                        {
                            unit = quantity <= 1 ? "No" : "Nos";
                        }
                        
                        double amount = quantity * rate;
                        totalAmount += amount;

                        // Combine description and default values in a single row
                        ws.Cells[currentRow, 1].Value = item.SlNo;
                        ws.Cells[currentRow, 2].Value = item.Description + " - " + subrow.DefaultValues;
                        ws.Cells[currentRow, 3].Value = quantity;
                        ws.Cells[currentRow, 4].Value = unit;
                        ws.Cells[currentRow, 5].Value = rate;
                        ws.Cells[currentRow, 6].Formula = $"C{currentRow}*E{currentRow}";

                        currentRow++;
                    }
                    else
                    {
                        // Multiple subrows - use original format with separate description row
                        ws.Cells[currentRow, 1].Value = item.SlNo;
                        ws.Cells[currentRow, 2].Value = item.Description;
                        ws.Cells[currentRow, 3].Value = "";
                        ws.Cells[currentRow, 4].Value = "";
                        ws.Cells[currentRow, 5].Value = "";
                        ws.Cells[currentRow, 6].Value = "";

                        currentRow++;

                        foreach (var subrow in item.Subrows)
                        {
                            double quantity = subrow.Quantity;
                            double rate = subrow.Rate;
                            
                            // Determine singular or plural form based on final quantity
                            string unit = subrow.Unit;
                            
                            // Update unit based on final quantity
                            if (unit.StartsWith("Mtr"))
                            {
                                unit = quantity <= 1 ? "Mtr" : "Mtrs";
                            }
                            else if (unit.StartsWith("Point"))
                            {
                                unit = quantity <= 1 ? "Point" : "Points";
                            }
                            else if (unit == "No")
                            {
                                unit = quantity <= 1 ? "No" : "Nos";
                            }
                            
                            double amount = quantity * rate;
                            totalAmount += amount;

                            ws.Cells[currentRow, 1].Value = subrow.SlNo;
                            ws.Cells[currentRow, 2].Value = subrow.DefaultValues;
                            ws.Cells[currentRow, 3].Value = quantity;
                            ws.Cells[currentRow, 4].Value = unit;
                            ws.Cells[currentRow, 5].Value = rate;
                            ws.Cells[currentRow, 6].Formula = $"C{currentRow}*E{currentRow}";

                            currentRow++;
                        }
                    }
                }

                // Additional code for setting column widths, total row, etc.
                var columnWidths = new Dictionary<string, double>
                {
                    { "A", 5 },  // Sl.No - Minimum width to ensure visibility
                    { "B", 60 }, // Description - Set as 60 for wider content
                    { "C", 5 },  // Quantity - Minimum width
                    { "D", 5 },  // Unit - Minimum width
                    { "E", 5 },  // Rate - Minimum width
                    { "F", 5 }   // Amount - Minimum width
                };

                // Calculate dynamic column widths based on cell content
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

                        if (cell.Value != null)
                        {
                            string colLetter = cell.Address[0].ToString();

                            if (colLetter == "B")
                            {
                                // Enable text wrapping for column B
                                cell.Style.WrapText = true;
                            }
                            else
                            {
                                // Update the column width based on content length
                                columnWidths[colLetter] = Math.Max(columnWidths[colLetter], cell.Value.ToString().Length + 2); // Add padding for readability
                            }
                        }
                    }
                }

                // Apply the calculated widths to the worksheet columns
                foreach (var col in columnWidths)
                {
                    int columnIndex = col.Key[0] - 'A' + 1; // Convert letter to column index
                    ws.Column(columnIndex).Width = col.Value;
                }


                // Set medium border for header row
                for (int colIndex = 1; colIndex <= 6; colIndex++)
                {
                    ws.Cells[1, colIndex].Style.Border.Bottom.Style = ExcelBorderStyle.Medium;
                    ws.Cells[1, colIndex].Style.Border.Top.Style = ExcelBorderStyle.Medium;
                    ws.Cells[1, colIndex].Style.Border.Left.Style = ExcelBorderStyle.Medium;
                    ws.Cells[1, colIndex].Style.Border.Right.Style = ExcelBorderStyle.Medium;
                }

                // Append total row
                int totalRow = currentRow;  // currentRow is the next available row
                ws.Cells[totalRow, 1].Value = "";
                ws.Cells[totalRow, 2].Value = "";
                ws.Cells[totalRow, 3].Value = "";
                ws.Cells[totalRow, 4].Value = "";
                ws.Cells[totalRow, 5].Value = "";
                ws.Cells[totalRow, 6].Value = "";

                // Merge cells C, D, and E for the total amount
                ws.Cells[totalRow, 3].Style.Border.Bottom.Style = ExcelBorderStyle.Medium;
                ws.Cells[totalRow, 4].Style.Border.Bottom.Style = ExcelBorderStyle.Medium;
                ws.Cells[totalRow, 5].Style.Border.Bottom.Style = ExcelBorderStyle.Medium;
                ws.Cells[totalRow, 3, totalRow, 5].Merge = true;

                // Set the value for the merged cell to "Total Amount"
                var mergedCell = ws.Cells[totalRow, 3];
                mergedCell.Value = "Total Amount : Rs ";
                mergedCell.Style.HorizontalAlignment = ExcelHorizontalAlignment.Center;
                mergedCell.Style.WrapText = true;

                // Set the value for the last column separately
                ws.Cells[totalRow, 6].Formula = $"SUM(F2:F{totalRow - 1})";
                ws.Cells[totalRow, 6].Style.Border.Bottom.Style = ExcelBorderStyle.Medium;

                // Convert total amount to words and add a new row
                ws.Cells[totalRow + 1, 1].Value = "";
                ws.Cells[totalRow + 1, 2].Value = "";
                ws.Cells[totalRow + 1, 3].Value = "";
                ws.Cells[totalRow + 1, 4].Value = "";
                ws.Cells[totalRow + 1, 5].Value = "";
                ws.Cells[totalRow + 1, 6].Value = "";

                // Merge cells A to F for the amount in words
                ws.Cells[totalRow + 1, 1, totalRow + 1, 6].Merge = true;
                ws.Cells[totalRow + 1, 1].Value = $"(Amount in Words : {totalAmount} Rupees Only.)";
                ws.Cells[totalRow + 1, 1].Style.WrapText = true;

                return package.GetAsByteArray();
            }
        }
    }
}
