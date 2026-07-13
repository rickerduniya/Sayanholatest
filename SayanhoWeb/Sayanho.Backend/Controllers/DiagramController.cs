using Microsoft.AspNetCore.Mvc;
using Sayanho.Backend.Security;
using Sayanho.Core.Models;
using System.Text.Json;

namespace Sayanho.Backend.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class DiagramController : ControllerBase
    {
        private readonly string _dataDirectory;

        public DiagramController(IWebHostEnvironment env)
        {
            _dataDirectory = Path.Combine(env.ContentRootPath, "Data", "Diagrams");
            if (!Directory.Exists(_dataDirectory))
            {
                Directory.CreateDirectory(_dataDirectory);
            }
        }

        [HttpGet]
        public IActionResult GetAllDiagrams()
        {
            var userDirectory = GetUserDirectory();
            if (userDirectory is null)
            {
                return Unauthorized();
            }

            var files = Directory.GetFiles(userDirectory, "*.json");
            var diagrams = files.Select(f => 
            {
                // Use filename (without extension) as the ID for delete operations
                var fileId = Path.GetFileNameWithoutExtension(f);
                try
                {
                    var json = System.IO.File.ReadAllText(f);
                    var project = JsonSerializer.Deserialize<ProjectData>(json);
                    // Return the FILENAME as id (for delete) but project name for display
                    return new { Id = fileId, Name = project?.Name ?? "Untitled" };
                }
                catch
                {
                    // Fallback for legacy files
                    return new { Id = fileId, Name = "Legacy Diagram" };
                }
            });
            return Ok(diagrams);
        }

        [HttpGet("{id}")]
        public IActionResult GetDiagram(string id)
        {
            var userDirectory = GetUserDirectory();
            var projectId = NormalizeProjectId(id);
            if (userDirectory is null)
            {
                return Unauthorized();
            }
            if (projectId is null)
            {
                return BadRequest(new { message = "Invalid project ID." });
            }

            var filePath = Path.Combine(userDirectory, $"{projectId}.json");
            if (!System.IO.File.Exists(filePath))
            {
                return NotFound();
            }

            var json = System.IO.File.ReadAllText(filePath);
            try 
            {
                var project = JsonSerializer.Deserialize<ProjectData>(json);
                return Ok(project);
            }
            catch
            {
                // Fallback for legacy single-sheet files
                var sheet = JsonSerializer.Deserialize<CanvasSheet>(json);
                return Ok(new ProjectData 
                { 
                    ProjectId = sheet.SheetId, 
                    Name = sheet.Name, 
                    CanvasSheets = new List<CanvasSheet> { sheet } 
                });
            }
        }

        [HttpPost]
        public IActionResult SaveDiagram([FromBody] ProjectData projectData)
        {
            var userDirectory = GetUserDirectory();
            if (userDirectory is null)
            {
                return Unauthorized();
            }
            if (string.IsNullOrWhiteSpace(projectData.Name) || projectData.Name.Length > 120)
            {
                return BadRequest(new { message = "Project name must be between 1 and 120 characters." });
            }

            // Generate a unique ID if not provided
            if (string.IsNullOrEmpty(projectData.ProjectId))
            {
                projectData.ProjectId = Guid.NewGuid().ToString();
            }
            else
            {
                var projectId = NormalizeProjectId(projectData.ProjectId);
                if (projectId is null)
                {
                    return BadRequest(new { message = "Invalid project ID." });
                }
                projectData.ProjectId = projectId;
            }

            var filePath = Path.Combine(userDirectory, $"{projectData.ProjectId}.json");
            var json = JsonSerializer.Serialize(projectData, new JsonSerializerOptions { WriteIndented = true });
            var temporaryFilePath = $"{filePath}.tmp";
            System.IO.File.WriteAllText(temporaryFilePath, json);
            System.IO.File.Move(temporaryFilePath, filePath, true);

            return Ok(new { ProjectId = projectData.ProjectId });
        }

        [HttpDelete("{id}")]
        public IActionResult DeleteDiagram(string id)
        {
            var userDirectory = GetUserDirectory();
            var projectId = NormalizeProjectId(id);
            if (userDirectory is null)
            {
                return Unauthorized();
            }
            if (projectId is null)
            {
                return BadRequest(new { message = "Invalid project ID." });
            }

            var filePath = Path.Combine(userDirectory, $"{projectId}.json");
            if (!System.IO.File.Exists(filePath))
            {
                return NotFound();
            }

            System.IO.File.Delete(filePath);
            return Ok(new { Message = "Project deleted successfully" });
        }

        private string? GetUserDirectory()
        {
            var userId = User.GetUserId();
            if (userId is null)
            {
                return null;
            }

            var userDirectory = Path.Combine(_dataDirectory, userId);
            Directory.CreateDirectory(userDirectory);
            return userDirectory;
        }

        private static string? NormalizeProjectId(string projectId) =>
            Guid.TryParse(projectId, out var parsedProjectId) ? parsedProjectId.ToString() : null;
    }
}
