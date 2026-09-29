using System.Security.Claims;

namespace TimeTurtle.Api.Auth;

public class CurrentUser(IHttpContextAccessor http)
{
    public Guid? UserId { get; } = Read(http, ClaimTypes.NameIdentifier);
    public Guid? CompanyId { get; } = Read(http, "company");

    private static Guid? Read(IHttpContextAccessor http, string type) =>
        Guid.TryParse(http.HttpContext?.User.FindFirstValue(type), out var id) ? id : null;
}
