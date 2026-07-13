using Sayanho.Core.Logic;
using Microsoft.AspNetCore.StaticFiles;
using Sayanho.Backend.Converters;
using Sayanho.Backend.Filters;
using Sayanho.Backend.Middleware;
using Sayanho.Backend.Services;
using PdfSharpCore.Fonts;
using Microsoft.AspNetCore.RateLimiting;
using System.Threading.RateLimiting;

// Configure PDFSharp Font Resolver
GlobalFontSettings.FontResolver = new CustomFontResolver();

var builder = WebApplication.CreateBuilder(args);

// Configure Kestrel to bind to all interfaces and use PORT from environment (for Render/Docker)
var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// Large project files are compressed by the client. Keep a bounded fallback size.
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 25 * 1024 * 1024; // 25MB
});

// Initialize DatabaseLoader
Sayanho.Core.Logic.DatabaseLoader.Initialize(builder.Environment.ContentRootPath);

// Add services to the container.
builder.Services.AddControllers(options =>
{
    // Add custom filter to log model binding errors
    options.Filters.Add<ModelBindingExceptionFilter>();
}).AddJsonOptions(options =>
{
    // Use camelCase to better interop with the frontend TypeScript models
    options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
    
    // Handle circular references (e.g., Connector.SourceItem -> CanvasItem -> Connector)
    options.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
    
    // Increase max depth to handle deep object graphs
    options.JsonSerializerOptions.MaxDepth = 128;
    
    // Add custom converters
    options.JsonSerializerOptions.Converters.Add(new ConnectorJsonConverter()); // Extract item IDs during deserialization
    options.JsonSerializerOptions.Converters.Add(new PointJsonConverter());
    options.JsonSerializerOptions.Converters.Add(new SizeJsonConverter());
});
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSingleton<AuthenticationService>();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddFixedWindowLimiter("auth", limiterOptions =>
    {
        limiterOptions.PermitLimit = 10;
        limiterOptions.Window = TimeSpan.FromMinutes(1);
        limiterOptions.QueueLimit = 0;
    });
});

// Add CORS - read allowed origins from appsettings
var allowedOrigins = builder.Configuration.GetSection("AllowedOrigins").Get<string[]>() ?? new string[0];

builder.Services.AddCors(options =>
{
    options.AddPolicy("ConfiguredCors", policy =>
    {
        if (allowedOrigins.Length > 0)
        {
            policy.WithOrigins(allowedOrigins)
                  .AllowAnyMethod()
                  .AllowAnyHeader();
        }
        else
        {
            policy.SetIsOriginAllowed(_ => false);
        }
    });
});

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors("ConfiguredCors");
app.UseRateLimiter();
app.UseMiddleware<SessionAuthenticationMiddleware>();

// Add decompression middleware to handle GZIP-compressed request bodies from frontend
// This must be BEFORE any middleware that reads the request body
app.UseDecompression();



// Enable static files (for serving SVG icons)
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        ctx.Context.Response.Headers.Append("Access-Control-Allow-Origin", "*");
    }
});

// Check if wwwroot/icons exists (Standard Production Path)
var wwwrootIconsPath = Path.Combine(builder.Environment.WebRootPath ?? Path.Combine(builder.Environment.ContentRootPath, "wwwroot"), "icons");
if (Directory.Exists(wwwrootIconsPath))
{
    Console.WriteLine($"Serving icons from standard path: {wwwrootIconsPath}");
}
else
{
    Console.WriteLine($"Warning: Standard icons directory not found at {wwwrootIconsPath}");
}

// Serve icons from the external directory (Local Development Fallback)
var externalIconsPath = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../Sayanho - C# version/icons"));
if (Directory.Exists(externalIconsPath))
{
    Console.WriteLine($"Serving icons from external path: {externalIconsPath}");
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(externalIconsPath),
        RequestPath = "/icons",
        OnPrepareResponse = ctx =>
        {
            ctx.Context.Response.Headers.Append("Access-Control-Allow-Origin", "*");
        }
    });
}

app.UseAuthorization();

// Health check endpoint for Render
app.MapGet("/", () => Results.Ok(new { status = "healthy", service = "Sayanho Backend API" }));

app.MapControllers();

app.Run();
