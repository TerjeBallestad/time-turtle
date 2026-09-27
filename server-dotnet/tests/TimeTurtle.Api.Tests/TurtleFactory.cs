using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

public class TurtleFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string Password = "correct horse battery";

    // Ada works for Turtle AS, Bob for Other AS, and Carol for both.
    public Company Turtle { get; } = new() { Name = "Turtle AS" };
    public Company Other { get; } = new() { Name = "Other AS" };

    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18").Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("ConnectionStrings:turtle", _pg.GetConnectionString());
    }

    public async Task InitializeAsync()
    {
        await _pg.StartAsync();
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TurtleDb>();
        await db.Database.MigrateAsync();

        var ada = NewUser("ada@turtle.test", "Ada");
        var bob = NewUser("bob@other.test", "Bob");
        var carol = NewUser("carol@both.test", "Carol");
        db.AddRange(Turtle, Other, ada, bob, carol);
        await db.SaveChangesAsync();
        db.AddRange(
            new Membership { UserId = ada.Id, CompanyId = Turtle.Id },
            new Membership { UserId = bob.Id, CompanyId = Other.Id },
            new Membership { UserId = carol.Id, CompanyId = Turtle.Id },
            new Membership { UserId = carol.Id, CompanyId = Other.Id }
        );
        await db.SaveChangesAsync();
    }

    private static User NewUser(string email, string name)
    {
        var user = new User
        {
            Email = email,
            Name = name,
            PasswordHash = "",
        };
        user.PasswordHash = new PasswordHasher<User>().HashPassword(user, Password);
        return user;
    }

    // A client that logged in as this user. The cookie stays in the client.
    public async Task<HttpClient> LoginAs(string email)
    {
        var http = CreateClient();
        var res = await http.PostAsJsonAsync("/api/login", new { email, password = Password });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return http;
    }

    public new async Task DisposeAsync() => await _pg.DisposeAsync();
}
