using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

public class KeyTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task Key_in_db_after_login()
    {
        factory.CreateClient();
        await factory.LoginAs("ada@turtle.test");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TurtleDb>();
        bool anyKeys = await db.DataProtectionKeys.AnyAsync();
        Assert.True(anyKeys);
    }
}
