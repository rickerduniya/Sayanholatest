using System.Security.Claims;
using Sayanho.Backend.Services;

namespace Sayanho.Backend.Middleware;

public sealed class SessionAuthenticationMiddleware
{
    private readonly RequestDelegate _next;

    public SessionAuthenticationMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, AuthenticationService authenticationService)
    {
        var authorization = context.Request.Headers.Authorization.ToString();
        if (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            var token = authorization["Bearer ".Length..].Trim();
            var user = authenticationService.GetUser(token);
            if (user is not null)
            {
                var identity = new ClaimsIdentity(new[]
                {
                    new Claim(ClaimTypes.NameIdentifier, user.Id),
                    new Claim(ClaimTypes.Email, user.Email),
                    new Claim(ClaimTypes.Name, user.DisplayName)
                }, "SessionToken");
                context.User = new ClaimsPrincipal(identity);
            }
        }

        await _next(context);
    }
}
