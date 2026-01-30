using System;
using System.Drawing;

namespace Sayanho.Core.Models
{
    public class CanvasItem
    {
        public string UniqueID { get; set; } = Guid.NewGuid().ToString();
        public string Name { get; set; } = string.Empty;
        public Point Position { get; set; }
        public Size Size { get; set; }
        public Dictionary<string, Point> ConnectionPoints { get; set; } = new();
        
        public List<Dictionary<string, string>> Properties { get; set; } = new();
        public string AlternativeCompany1 { get; set; } = string.Empty;
        public string AlternativeCompany2 { get; set; } = string.Empty;
        
        public string? SvgContent { get; set; }
        public string? IconPath { get; set; }
        public double Rotation { get; set; } // Added Rotation to match frontend
        
        public bool Locked { get; set; } = false;
        public Dictionary<string, Point> IdPoints { get; set; } = new();
        public Dictionary<string, string> Incomer { get; set; } = new();
        public List<Dictionary<string, string>> Outgoing { get; set; } = new();
        public List<Dictionary<string, string>> Accessories { get; set; } = new();

        public CanvasItem Clone()
        {
             return new CanvasItem
            {
                UniqueID = this.UniqueID,
                Name = this.Name,
                Position = this.Position,
                Size = this.Size,
                ConnectionPoints = new Dictionary<string, Point>(this.ConnectionPoints),
                Properties = this.Properties.Select(d => new Dictionary<string, string>(d)).ToList(),
                AlternativeCompany1 = this.AlternativeCompany1,
                AlternativeCompany2 = this.AlternativeCompany2,
                SvgContent = this.SvgContent,
                IconPath = this.IconPath,
                Rotation = this.Rotation,
                Locked = this.Locked,
                IdPoints = new Dictionary<string, Point>(this.IdPoints),
                Incomer = new Dictionary<string, string>(this.Incomer),
                Outgoing = this.Outgoing.Select(d => new Dictionary<string, string>(d)).ToList(),
                Accessories = this.Accessories.Select(d => new Dictionary<string, string>(d)).ToList()
            };
        }
    }
}
