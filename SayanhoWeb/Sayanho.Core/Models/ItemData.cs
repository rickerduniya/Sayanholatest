using System.Drawing;

namespace Sayanho.Core.Models
{
    public class ItemData
    {
        public string Name { get; set; } = string.Empty;
        public int Quantity { get; set; }
        public int Rate { get; set; }
        public int Power { get; set; }
        public Size Size { get; set; }
        public string IconPath { get; set; } = string.Empty; // Renamed from icon
        public Dictionary<string, Point> ConnectionPoints { get; set; } = new(); // Renamed from connectionpoint
        public List<Dictionary<string, string>> Outgoing { get; set; } = new();
        public List<string> IncomingPriorityList { get; set; } = new();
    }
}
