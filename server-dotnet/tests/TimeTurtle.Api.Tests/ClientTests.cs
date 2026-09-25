using System.Net;
using System.Net.Http.Json;

namespace TimeTurtle.Api.Tests;

public class ClientTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task A_new_client_is_listed()
    {
        var http = factory.CreateClient();
        var res = await http.PostAsJsonAsync("/api/clients", new { name = "Acme" });
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var list = await http.GetFromJsonAsync<List<ClientBody>>("/api/clients");
        Assert.Contains(list!, c => c.Name == "Acme");
    }

    [Fact]
    public async Task A_second_active_client_with_the_same_name_is_a_conflict()
    {
        var http = factory.CreateClient();
        await http.PostAsJsonAsync("/api/clients", new { name = "Globex" });
        var res = await http.PostAsJsonAsync("/api/clients", new { name = "Globex" });
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
    }

    [Fact]
    public async Task An_empty_name_is_refused()
    {
        var http = factory.CreateClient();
        var res = await http.PostAsJsonAsync("/api/clients", new { name = "  " });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task A_missing_name_is_refused()
    {
        var http = factory.CreateClient();
        var res = await http.PostAsJsonAsync("/api/clients", new { });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    private record ClientBody(int Id, string Name);
}
