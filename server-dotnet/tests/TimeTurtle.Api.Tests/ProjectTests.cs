using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

public class ProjectTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task A_person_sees_a_project_they_are_assigned_to()
    {
        var client = new Client
        {
            Id = Guid.CreateVersion7(),
            CompanyId = factory.Turtle.Id,
            Name = "Initech",
        };
        await Save(client);
        await Assign("ada@turtle.test", await NewProject("SEEN", clientId: client.Id));

        var list = await ProjectsOf("ada@turtle.test");
        var seen = Assert.Single(list, p => p.Code == "SEEN");
        Assert.Equal("Initech", seen.ClientName);
    }

    [Fact]
    public async Task A_person_does_not_see_a_project_they_are_not_assigned_to()
    {
        await Assign("carol@both.test", await NewProject("NOTADA"));
        Assert.DoesNotContain(await ProjectsOf("ada@turtle.test"), p => p.Code == "NOTADA");
    }

    [Fact]
    public async Task An_ended_assignment_hides_the_project()
    {
        await Assign("ada@turtle.test", await NewProject("ENDED"), ended: true);
        Assert.DoesNotContain(await ProjectsOf("ada@turtle.test"), p => p.Code == "ENDED");
    }

    [Fact]
    public async Task An_archived_project_is_hidden()
    {
        await Assign("ada@turtle.test", await NewProject("GONE", archived: true));
        Assert.DoesNotContain(await ProjectsOf("ada@turtle.test"), p => p.Code == "GONE");
    }

    [Fact]
    public async Task A_person_in_two_companies_sees_only_the_chosen_company()
    {
        await Assign("carol@both.test", await NewProject("THERE", factory.Other), factory.Other);
        await Assign("carol@both.test", await NewProject("HERE"));

        var http = await factory.LoginAs("carol@both.test");
        await http.PostAsJsonAsync("/api/session/company", new { companyId = factory.Turtle.Id });
        var list = await http.GetFromJsonAsync<List<ProjectBody>>("/api/projects");

        Assert.Contains(list!, p => p.Code == "HERE");
        Assert.DoesNotContain(list!, p => p.Code == "THERE");
    }

    [Fact]
    public async Task The_list_has_no_rate()
    {
        await Assign("ada@turtle.test", await NewProject("NORATE"), rate: 1500m);

        var http = await factory.LoginAs("ada@turtle.test");
        var json = await http.GetFromJsonAsync<JsonElement>("/api/projects");
        var project = json.EnumerateArray()
            .Single(p => p.GetProperty("code").GetString() == "NORATE");
        Assert.DoesNotContain(project.EnumerateObject(), f => f.Name.Contains("rate"));
    }

    [Fact]
    public async Task No_chosen_company_is_refused()
    {
        var http = await factory.LoginAs("carol@both.test");
        var res = await http.GetAsync("/api/projects");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    private async Task<List<ProjectBody>> ProjectsOf(string email)
    {
        var http = await factory.LoginAs(email);
        return (await http.GetFromJsonAsync<List<ProjectBody>>("/api/projects"))!;
    }

    private async Task<Project> NewProject(
        string code,
        Company? company = null,
        Guid? clientId = null,
        bool archived = false
    )
    {
        var project = new Project
        {
            Id = Guid.CreateVersion7(),
            CompanyId = (company ?? factory.Turtle).Id,
            ClientId = clientId,
            Code = code,
            Name = $"Project {code}",
            Archived = archived,
        };
        await Save(project);
        return project;
    }

    private async Task Assign(
        string email,
        Project project,
        Company? company = null,
        bool ended = false,
        decimal? rate = null
    )
    {
        var assignment = new Assignment
        {
            Id = Guid.CreateVersion7(),
            MembershipId = await factory.MembershipOf(email, company ?? factory.Turtle),
            ProjectId = project.Id,
            EndedAt = ended ? DateTimeOffset.UtcNow : null,
        };
        await Save(assignment);
        if (rate != null)
        {
            await Save(
                new AssignmentRate
                {
                    AssignmentId = assignment.Id,
                    ValidFrom = new DateOnly(2026, 1, 1),
                    Rate = rate.Value,
                }
            );
        }
    }

    private Task<int> Save(object row) =>
        factory.WithDb(db =>
        {
            db.Add(row);
            return db.SaveChangesAsync();
        });

    private record ProjectBody(
        Guid Id,
        string Code,
        string Name,
        Guid? ClientId,
        string? ClientName
    );
}
