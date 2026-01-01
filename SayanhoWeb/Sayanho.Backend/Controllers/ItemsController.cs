using Microsoft.AspNetCore.Mvc;
using Sayanho.Core.Models;
using Sayanho.Core.Logic;
using System.Collections.Generic;
using System.Linq;
using System.Drawing;

namespace Sayanho.Backend.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class ItemsController : ControllerBase
    {
        [HttpGet]
        public IEnumerable<ItemData> Get()
        {
            // List of item names to fetch from database
            var itemNames = new List<string>
            {
                "Source", "Main Switch", "Change Over Switch", "SPN DB", 
                "Bulb", "Tube Light", "Call Bell", "Ceiling Fan", "VTPN", "HTPN", "Point Switch Board",
                "Avg. 5A Switch Board", "AC Point", "Geyser Point", "Exhaust Fan",
                "LT Cubical Panel"
            };

            var items = new List<ItemData>();


            foreach (var name in itemNames)
            {
                var (properties, _, _) = DatabaseLoader.LoadDefaultPropertiesFromDatabase(name, 0);
                
                // Create ItemData with default values
                var item = new ItemData
                {
                    Name = name,
                    Quantity = 0,
                    Rate = 0,
                    Power = 0,
                    Size = GetDefaultSize(name),
                    IconPath = GetIconPath(name),
                    ConnectionPoints = GetDefaultConnectionPoints(name)
                };

                // Try to parse power/rate from properties if available
                if (properties.Any())
                {
                    var firstProp = properties.First();
                    if (firstProp.ContainsKey("Rate") && double.TryParse(firstProp["Rate"], out double rate))
                        item.Rate = (int)rate;
                    // Power parsing logic would go here if available in properties
                }

                items.Add(item);
            }

            return items;
        }

        [HttpGet("properties")]
        public IActionResult GetProperties([FromQuery] string name, [FromQuery] int condition = 0)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return BadRequest(new { message = "Item name is required" });
            }

            var (properties, alt1, alt2) = DatabaseLoader.LoadDefaultPropertiesFromDatabase(name, condition);
            return Ok(new
            {
                properties,
                alternativeCompany1 = alt1,
                alternativeCompany2 = alt2
            });
        }

        private System.Drawing.Size GetDefaultSize(string name)
        {
            return name switch
            {
                "Source" => new System.Drawing.Size(60, 60),
                "Main Switch" => new System.Drawing.Size(60, 80),
                "Change Over Switch" => new System.Drawing.Size(80, 80),
                "SPN DB" => new System.Drawing.Size(100, 120),
                "VTPN" => new System.Drawing.Size(120, 150),
                "LT Cubical Panel" => new System.Drawing.Size(300, 200),
                "HTPN" => new System.Drawing.Size(150, 120),
                "Bulb" => new System.Drawing.Size(40, 40),
                "Tube Light" => new System.Drawing.Size(50, 50),
                "Call Bell" => new System.Drawing.Size(50, 50),
                "Ceiling Fan" => new System.Drawing.Size(50, 50),
                _ => new System.Drawing.Size(60, 60)
            };
        }

        private Dictionary<string, System.Drawing.Point> GetDefaultConnectionPoints(string name)
        {
            var points = new Dictionary<string, System.Drawing.Point>();
            
            switch (name)
            {
                case "Source":
                    points.Add("Out", new System.Drawing.Point(30, 60));
                    break;
                case "Main Switch":
                    points.Add("In", new System.Drawing.Point(30, 0));
                    points.Add("Out", new System.Drawing.Point(30, 80));
                    break;
                case "Change Over Switch":
                    points.Add("In1", new System.Drawing.Point(24, 0));
                    points.Add("In2", new System.Drawing.Point(68, 0));
                    points.Add("Out", new System.Drawing.Point(47, 80));
                    break;
                case "SPN DB":
                    points.Add("In", new System.Drawing.Point(50, 0));
                    points.Add("Out1", new System.Drawing.Point(20, 120));
                    points.Add("Out2", new System.Drawing.Point(50, 120));
                    points.Add("Out3", new System.Drawing.Point(80, 120));
                    break;
                case "VTPN":
                    points.Add("In", new System.Drawing.Point(60, 0));
                    points.Add("Out", new System.Drawing.Point(60, 150));
                    break;
                case "HTPN":
                    points.Add("In", new System.Drawing.Point(75, 0));
                    points.Add("Out", new System.Drawing.Point(75, 120));
                    break;
                default:
                    points.Add("In", new System.Drawing.Point(0, 0));
                    break;
            }
            return points;
        }

        private string GetIconPath(string name)
        {
            // Map item names to their SVG icon file names
            var iconMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "Source", "source.svg" },
                { "Main Switch", "main switch.svg" },
                { "Change Over Switch", "change over.svg" },
                { "SPN DB", "SPN DB.svg" },
                { "VTPN", "vtpn.svg" },
                { "HTPN", "HTPN.svg" },
                { "Bulb", "bulb.svg" },
                { "Ceiling Fan", "ceiling-fan.svg" },
                { "Point Switch Board", "point_switch_board.svg" },
                { "Avg. 5A Switch Board", "avg_5a_switch_board.svg" },
                { "AC Point", "split-ac.svg" },
                { "Geyser Point", "geyser.svg" },
                { "Exhaust Fan", "exhaust-fan.svg" },
                { "Tube Light", "tube-light.svg" },
                { "Call Bell", "call-bell.svg" },
                { "Garden Light", "garden-light.svg" },
                { "Gate Light", "gate-light.svg" },
                { "LT Cubical Panel", "cubicle_panel.svg" }
            };

            if (iconMap.TryGetValue(name, out var iconFile))
            {
                return $"/icons/{iconFile}";
            }

            return "/icons/load.svg"; // Default icon
        }
    }
}
