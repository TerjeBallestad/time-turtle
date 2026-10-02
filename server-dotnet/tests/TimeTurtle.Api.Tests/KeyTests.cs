using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

public class KeyTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task Key_in_db_after_login()
    {
        await factory.LoginAs("ada@turtle.test");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TurtleDb>();
        bool anyKeys = await db.DataProtectionKeys.AnyAsync();
        Assert.True(anyKeys);
    }

    [Fact]
    public async Task All_keys_encrypted()
    {
        await factory.LoginAs("ada@turtle.test");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TurtleDb>();
        var keys = await db.DataProtectionKeys.Select(k => k.Xml).ToListAsync();
        Assert.NotEmpty(keys);
        Assert.All(keys, key => Assert.DoesNotContain("<masterKey", key));
        Assert.All(keys, key => Assert.Contains("<encryptedSecret", key));
    }

    [Fact]
    public async Task Wrong_certificate_stops_the_start()
    {
        await factory.LoginAs("ada@turtle.test");
        var otherPath = TurtleFactory.WritePfx("CN=wrong-keys");
        try
        {
            using var other = factory.WithWebHostBuilder(b =>
                b.UseSetting("KeyCertificate:Path", otherPath)
            );
            Assert.ThrowsAny<Exception>(other.CreateClient);
        }
        finally
        {
            File.Delete(otherPath);
        }
    }
}
