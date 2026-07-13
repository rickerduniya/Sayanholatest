using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Sayanho.Backend.Security;
using Sayanho.Backend.Services;

namespace Sayanho.Backend.Controllers;

[ApiController]
[Route("api/auth")]
public sealed class AuthController : ControllerBase
{
    private readonly AuthenticationService _authenticationService;

    public AuthController(AuthenticationService authenticationService)
    {
        _authenticationService = authenticationService;
    }

    [HttpPost("register")]
    [EnableRateLimiting("auth")]
    public IActionResult Register([FromBody] RegisterRequest request)
    {
        try
        {
            return Ok(_authenticationService.Register(request.Email, request.Password, request.DisplayName));
        }
        catch (AuthenticationException exception)
        {
            return BadRequest(new { message = exception.Message });
        }
    }

    [HttpPost("login")]
    [EnableRateLimiting("auth")]
    public IActionResult Login([FromBody] LoginRequest request)
    {
        try
        {
            return Ok(_authenticationService.Login(request.Email, request.Password));
        }
        catch (AuthenticationException)
        {
            return Unauthorized(new { message = "Invalid email or password." });
        }
    }

    [HttpGet("me")]
    public IActionResult Me()
    {
        var userId = User.GetUserId();
        if (userId is null)
        {
            return Unauthorized();
        }

        return Ok(new
        {
            id = userId,
            email = User.FindFirst(System.Security.Claims.ClaimTypes.Email)?.Value,
            displayName = User.Identity?.Name
        });
    }

    [HttpPost("logout")]
    public IActionResult Logout()
    {
        var authorization = Request.Headers.Authorization.ToString();
        if (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            _authenticationService.Logout(authorization["Bearer ".Length..].Trim());
        }

        return NoContent();
    }
}

public sealed class RegisterRequest
{
    public string Email { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
}

public sealed class LoginRequest
{
    public string Email { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}
