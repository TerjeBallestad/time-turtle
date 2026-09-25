using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Testcontainers.PostgreSql;

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
    }

    public new async Task DisposeAsync() => await _pg.DisposeAsync();
}
