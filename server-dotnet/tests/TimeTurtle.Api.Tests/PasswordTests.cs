using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

public class PasswordTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task Password_change_ends_other_logins()
    {
        var phone = await factory.LoginAs("bob@other.test");
        var laptop = await factory.LoginAs("bob@other.test");

        var res = await laptop.PostAsJsonAsync(
            "/api/me/password",
            new { currentPassword = TurtleFactory.Password, newPassword = "a brand new password" }
        );
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.GetAsync("/api/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await laptop.GetAsync("/api/me")).StatusCode);
    }

    [Fact]
    public async Task Wrong_current_password_is_refused()
    {
        var ada = await factory.LoginAs("ada@turtle.test");
        var res = await ada.PostAsJsonAsync(
            "/api/me/password",
            new { currentPassword = "not her password", newPassword = "a brand new password" }
        );
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        // A refused change logs nobody out.
        Assert.Equal(HttpStatusCode.OK, (await ada.GetAsync("/api/me")).StatusCode);
    }

    [Fact]
    public async Task Removed_membership_ends_the_login()
    {
        var carol = await factory.LoginAs("carol@both.test");
        await carol.PostAsJsonAsync("/api/session/company", new { companyId = factory.Other.Id });
        // Blank 3: one line, before the delete. Read the last fact.
        Assert.Equal(HttpStatusCode.OK, (await carol.GetAsync("/api/clients")).StatusCode);

        // Delete Carol's membership in Other AS, as an admin would.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TurtleDb>();
            var carolId = await db
                .Users.Where(u => u.Email == "carol@both.test")
                .Select(u => u.Id)
                .SingleAsync();
            await db
                .Memberships.Where(m => m.UserId == carolId && m.CompanyId == factory.Other.Id)
                .ExecuteDeleteAsync();
        }

        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await carol.GetAsync("/api/clients")).StatusCode
        );
    }
}
