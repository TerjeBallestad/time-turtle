using System.Net;
using System.Net.Http.Json;

namespace TimeTurtle.Api.Tests;

public class LoginTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task The_right_password_logs_in()
    {
        var http = factory.CreateClient();
        var res = await http.PostAsJsonAsync(
            "/api/login",
            new { email = "ada@turtle.test", password = TurtleFactory.Password }
        );
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var me = await http.GetFromJsonAsync<MeBody>("/api/me");
        Assert.Equal("ada@turtle.test", me!.Email);
        Assert.Equal(factory.Turtle.Id, me.CompanyId);
    }

    [Fact]
    public async Task Wrong_password_unauthorized()
    {
        var http = factory.CreateClient();
        var res = await http.PostAsJsonAsync(
            "/api/login",
            new { email = "ada@turtle.test", password = "wrongpassword" }
        );
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Unknown_email_unauthorized()
    {
        var http = factory.CreateClient();
        var res = await http.PostAsJsonAsync(
            "/api/login",
            new { email = "wrong@example.com", password = TurtleFactory.Password }
        );
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Me_without_login_unauthorized()
    {
        var http = factory.CreateClient();
        var me = await http.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
    }

    private record MeBody(Guid Id, string Email, string Name, Guid? CompanyId);
}
