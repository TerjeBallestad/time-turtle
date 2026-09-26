using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

public class TurtleFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18").Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("ConnectionStrings:turtle", _pg.GetConnectionString());
    }

    public async Task InitializeAsync()
    {
        await _pg.StartAsync();
        using var scope = Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<TurtleDb>().Database.MigrateAsync();
    }

    public new async Task DisposeAsync() => await _pg.DisposeAsync();
}
