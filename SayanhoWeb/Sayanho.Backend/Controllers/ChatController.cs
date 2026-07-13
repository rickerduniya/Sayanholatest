using Microsoft.AspNetCore.Mvc;
using Sayanho.Core.Logic;
using System.Collections.Generic;
using Microsoft.Data.Sqlite;
using System.Linq;
using Sayanho.Backend.Security;

namespace Sayanho.Backend.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class ChatController : ControllerBase
    {
        [HttpGet("schema")]
        public IActionResult GetSchema()
        {
            if (User.GetUserId() is null)
            {
                return Unauthorized();
            }

            var result = new Dictionary<string, object>();
            var schema = new Dictionary<string, object>();

            try
            {
                using var conn = DatabaseLoader.OpenConnection();
                
                // 1. Get all tables
                var tables = new List<string>();
                using (var cmd = conn.CreateCommand())
                {
                    cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';";
                    using var reader = cmd.ExecuteReader();
                    while (reader.Read())
                    {
                        tables.Add(reader.GetString(0));
                    }
                }

                // 2. Get full Index table
                if (tables.Contains("Index"))
                {
                    var indexData = new List<Dictionary<string, object>>();
                    using (var cmd = conn.CreateCommand())
                    {
                        cmd.CommandText = "SELECT * FROM \"Index\"";
                        using var reader = cmd.ExecuteReader();
                        while (reader.Read())
                        {
                            var row = new Dictionary<string, object>();
                            for (int i = 0; i < reader.FieldCount; i++)
                            {
                                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                            }
                            indexData.Add(row);
                        }
                    }
                    result["IndexTable"] = indexData;
                }

                // 3. Get columns and sample row for each table
                foreach (var table in tables)
                {
                    var tableInfo = new Dictionary<string, object>();
                    
                    // Columns
                    var columns = new List<string>();
                    using (var cmd = conn.CreateCommand())
                    {
                        cmd.CommandText = $"PRAGMA table_info(\"{table}\");";
                        using var reader = cmd.ExecuteReader();
                        while (reader.Read())
                        {
                            columns.Add($"{reader.GetString(1)} ({reader.GetString(2)})");
                        }
                    }
                    tableInfo["Columns"] = columns;

                    // Sample Row (First row)
                    var sampleRow = new Dictionary<string, object>();
                    using (var cmd = conn.CreateCommand())
                    {
                        cmd.CommandText = $"SELECT * FROM \"{table}\" LIMIT 1;";
                        using var reader = cmd.ExecuteReader();
                        if (reader.Read())
                        {
                            for (int i = 0; i < reader.FieldCount; i++)
                            {
                                sampleRow[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                            }
                        }
                    }
                    tableInfo["Sample"] = sampleRow;

                    schema[table] = tableInfo;
                }

                result["Tables"] = schema;

                return Ok(result);
            }
            catch (System.Exception ex)
            {
                return StatusCode(500, new { message = ex.Message });
            }
        }

        [HttpPost("query")]
        public IActionResult ExecuteQuery([FromBody] QueryRequest request)
        {
            if (User.GetUserId() is null)
            {
                return Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(request.Query))
            {
                return BadRequest(new { message = "Query is required" });
            }

            var query = request.Query.Trim();
            var prohibitedTerms = new[] { ";", "ATTACH", "DETACH", "PRAGMA", "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "VACUUM" };
            if (!query.StartsWith("SELECT", System.StringComparison.OrdinalIgnoreCase) || prohibitedTerms.Any(term => query.Contains(term, System.StringComparison.OrdinalIgnoreCase)))
            {
                return BadRequest(new { message = "Only a single read-only SELECT query is allowed." });
            }

            try
            {
                using var conn = DatabaseLoader.OpenConnection();
                using var cmd = conn.CreateCommand();
                cmd.CommandText = query;
                cmd.CommandTimeout = 5;

                var results = new List<Dictionary<string, object>>();
                using var reader = cmd.ExecuteReader();
                
                while (reader.Read() && results.Count < 500)
                {
                    var row = new Dictionary<string, object>();
                    for (int i = 0; i < reader.FieldCount; i++)
                    {
                        var name = reader.GetName(i);
                        var value = reader.IsDBNull(i) ? null : reader.GetValue(i);
                        row[name] = value;
                    }
                    results.Add(row);
                }

                return Ok(results);
            }
            catch (System.Exception ex)
            {
                return BadRequest(new { message = ex.Message });
            }
        }

        public class QueryRequest
        {
            public string Query { get; set; }
        }
    }
}
