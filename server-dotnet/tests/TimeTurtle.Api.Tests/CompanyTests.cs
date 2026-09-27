using System.Net;
using System.Net.Http.Json;

namespace TimeTurtle.Api.Tests;

public class CompanyTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task Clients_without_a_login_are_refused()
    {
        var http = factory.CreateClient();
        var res = await http.GetAsync("/api/clients");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task The_chosen_company_decides_what_is_listed()
    {
        var ada = await factory.LoginAs("ada@turtle.test");
        var made = await ada.PostAsJsonAsync("/api/clients", new { name = "Hooli" });
        Assert.Equal(HttpStatusCode.Created, made.StatusCode);

        var carol = await factory.LoginAs("carol@both.test");
        var chose = await carol.PostAsJsonAsync(
            "/api/session/company",
            new { companyId = factory.Other.Id }
        );
        Assert.Equal(HttpStatusCode.OK, chose.StatusCode);
        var me = await carol.GetFromJsonAsync<MeBody>("/api/me");
        Assert.Equal(factory.Other.Id, me!.CompanyId);
        var inOther = await carol.GetFromJsonAsync<List<ClientBody>>("/api/clients");
        Assert.DoesNotContain(inOther!, c => c.Name == "Hooli");

        await carol.PostAsJsonAsync("/api/session/company", new { companyId = factory.Turtle.Id });
        var inTurtle = await carol.GetFromJsonAsync<List<ClientBody>>("/api/clients");
        Assert.Contains(inTurtle!, c => c.Name == "Hooli");
    }

    [Fact]
    public async Task Client_posted_to_other_company_is_not_listed()
    {
        var ada = await factory.LoginAs("ada@turtle.test");
        var made = await ada.PostAsJsonAsync("/api/clients", new { name = "DNB" });
        Assert.Equal(HttpStatusCode.Created, made.StatusCode);
        var bob = await factory.LoginAs("bob@other.test");
        var bobsClients = await bob.GetFromJsonAsync<List<ClientBody>>("/api/clients");
        Assert.DoesNotContain(bobsClients!, c => c.Name == "DNB");
    }

    [Fact]
    public async Task Duplicate_clients_allowed_in_separate_companies()
    {
        var ada = await factory.LoginAs("ada@turtle.test");
        await ada.PostAsJsonAsync("/api/clients", new { name = "Narvesen" });
        var bob = await factory.LoginAs("bob@other.test");
        var clients = await bob.PostAsJsonAsync("/api/clients", new { name = "Narvesen" });
        Assert.Equal(HttpStatusCode.Created, clients.StatusCode);
    }

    [Fact]
    public async Task Client_list_forbidden_with_company_unchosen()
    {
        var carol = await factory.LoginAs("carol@both.test");
        var clients = await carol.GetAsync("/api/clients");
        Assert.Equal(HttpStatusCode.Forbidden, clients.StatusCode);
    }

    [Fact]
    public async Task Choosing_unaffiliated_company_forbidden()
    {
        var ada = await factory.LoginAs("ada@turtle.test");
        var chose = await ada.PostAsJsonAsync(
            "/api/session/company",
            new { companyId = factory.Other.Id }
        );
        Assert.Equal(HttpStatusCode.Forbidden, chose.StatusCode);
    }

    private record ClientBody(Guid Id, string Name);

    private record MeBody(Guid Id, string Email, string Name, Guid? CompanyId);
}
