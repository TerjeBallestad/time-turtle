using Microsoft.EntityFrameworkCore;
using Npgsql;
using TimeTurtle.Api.Data;

namespace TimeTurtle.Api.Tests;

// Postgres itself enforces these rules, so they hold for every writer, not only for the routes.
public class ProjectTableTests(TurtleFactory factory) : IClassFixture<TurtleFactory>
{
    [Fact]
    public async Task A_second_active_project_with_the_same_code_is_refused()
    {
        await Save(NewProject("DUP"));
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Save(NewProject("DUP")));
        Assert.Equal(PostgresErrorCodes.UniqueViolation, SqlState(ex));
    }

    [Fact]
    public async Task Archiving_a_project_frees_its_code()
    {
        var old = NewProject("REUSE");
        await Save(old);
        await factory.WithDb(db =>
            db.Projects.IgnoreQueryFilters()
                .Where(p => p.Id == old.Id)
                .ExecuteUpdateAsync(u => u.SetProperty(p => p.Archived, true))
        );
        await Save(NewProject("REUSE"));
    }

    [Fact]
    public async Task Two_companies_may_use_the_same_code()
    {
        await Save(NewProject("SHARED"));
        await Save(NewProject("SHARED", factory.Other));
    }

    [Fact]
    public async Task A_project_cannot_have_another_companys_client()
    {
        var client = new Client
        {
            Id = Guid.CreateVersion7(),
            CompanyId = factory.Other.Id,
            Name = "Elsewhere",
        };
        await Save(client);
        var project = NewProject("FOREIGN");
        project.ClientId = client.Id;

        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Save(project));
        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, SqlState(ex));
    }

    [Fact]
    public async Task A_membership_in_one_company_cannot_be_assigned_to_a_project_in_another()
    {
        // Carol works in both companies. Her Other AS membership must not reach a Turtle project.
        var project = NewProject("XLEAK");
        await Save(project);
        var carolOther = await factory.MembershipOf("carol@both.test", factory.Other);

        foreach (var company in new[] { factory.Turtle, factory.Other })
        {
            var ex = await Assert.ThrowsAsync<DbUpdateException>(() =>
                Save(
                    new Assignment
                    {
                        CompanyId = company.Id,
                        MembershipId = carolOther,
                        ProjectId = project.Id,
                    }
                )
            );
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, SqlState(ex));
        }
    }

    [Fact]
    public async Task A_second_active_assignment_for_one_person_on_one_project_is_refused()
    {
        var project = NewProject("TWICE");
        var ada = await Ada();
        await Save(project, Assign(project, ada));
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Save(Assign(project, ada)));
        Assert.Equal(PostgresErrorCodes.UniqueViolation, SqlState(ex));
    }

    [Fact]
    public async Task An_ended_assignment_allows_a_new_one()
    {
        var project = NewProject("AGAIN");
        var ended = Assign(project, await Ada());
        ended.EndedAt = DateTimeOffset.UtcNow;
        await Save(project, ended);
        await Save(Assign(project, ended.MembershipId));
    }

    // ON DELETE RESTRICT answers 23001, not the 23503 of a missing parent on insert.
    [Fact]
    public async Task A_project_with_an_assignment_cannot_be_deleted()
    {
        var project = NewProject("KEEP");
        await Save(project, Assign(project, await Ada()));
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Delete(project));
        Assert.Equal(PostgresErrorCodes.RestrictViolation, SqlState(ex));
    }

    [Fact]
    public async Task A_membership_with_an_assignment_cannot_be_deleted()
    {
        // Carol's Turtle membership is used only here, so no other test depends on it surviving.
        var project = NewProject("STAY");
        var carol = await factory.MembershipOf("carol@both.test", factory.Turtle);
        await Save(project, Assign(project, carol));
        var membership = await factory.WithDb(db => db.Memberships.SingleAsync(m => m.Id == carol));
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Delete(membership));
        Assert.Equal(PostgresErrorCodes.RestrictViolation, SqlState(ex));
    }

    [Fact]
    public async Task An_assignment_with_a_rate_cannot_be_deleted()
    {
        var project = NewProject("PRICED");
        var assignment = Assign(project, await Ada());
        await Save(project, assignment, NewRate(assignment, new DateOnly(2026, 10, 1)));
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Delete(assignment));
        Assert.Equal(PostgresErrorCodes.RestrictViolation, SqlState(ex));
    }

    [Fact]
    public async Task Two_rates_from_the_same_date_are_refused()
    {
        var project = NewProject("PRICE");
        var assignment = Assign(project, await Ada());
        var day = new DateOnly(2026, 10, 1);
        await Save(project, assignment, NewRate(assignment, day));
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => Save(NewRate(assignment, day)));
        Assert.Equal(PostgresErrorCodes.UniqueViolation, SqlState(ex));
    }

    [Fact]
    public async Task A_rate_is_stored_in_whole_ore_and_a_third_decimal_is_rounded()
    {
        var project = NewProject("ORE");
        var assignment = Assign(project, await Ada());
        var rate = NewRate(assignment, new DateOnly(2026, 10, 1));
        rate.Rate = 1250.125m;
        await Save(project, assignment, rate);

        var stored = await factory.WithDb(db =>
            db.AssignmentRates.IgnoreQueryFilters()
                .Where(r => r.Id == rate.Id)
                .Select(r => r.Rate)
                .SingleAsync()
        );
        Assert.Equal(1250.13m, stored);
    }

    [Fact]
    public async Task The_company_filter_hides_another_companys_assignments_and_rates()
    {
        var mine = NewProject("FILTERME");
        var theirs = NewProject("FILTERTHEM", factory.Other);
        var myAssignment = Assign(mine, await Ada());
        var theirAssignment = Assign(
            theirs,
            await factory.MembershipOf("bob@other.test", factory.Other)
        );
        var day = new DateOnly(2026, 10, 1);
        await Save(
            mine,
            theirs,
            myAssignment,
            theirAssignment,
            NewRate(myAssignment, day),
            NewRate(theirAssignment, day)
        );

        var (assignments, rates) = await factory.WithDbAs(
            factory.Turtle,
            async db =>
                (
                    await db.Assignments.Select(a => a.Id).ToListAsync(),
                    await db.AssignmentRates.Select(r => r.AssignmentId).ToListAsync()
                )
        );
        Assert.Contains(myAssignment.Id, assignments);
        Assert.DoesNotContain(theirAssignment.Id, assignments);
        Assert.Contains(myAssignment.Id, rates);
        Assert.DoesNotContain(theirAssignment.Id, rates);
    }

    private Task<Guid> Ada() => factory.MembershipOf("ada@turtle.test", factory.Turtle);

    private Project NewProject(string code, Company? company = null) =>
        new()
        {
            Id = Guid.CreateVersion7(),
            CompanyId = (company ?? factory.Turtle).Id,
            Code = code,
            Name = code,
        };

    private static Assignment Assign(Project project, Guid membershipId) =>
        new()
        {
            Id = Guid.CreateVersion7(),
            CompanyId = project.CompanyId,
            MembershipId = membershipId,
            ProjectId = project.Id,
        };

    private static AssignmentRate NewRate(Assignment assignment, DateOnly validFrom) =>
        new()
        {
            AssignmentId = assignment.Id,
            ValidFrom = validFrom,
            Rate = 1250.50m,
        };

    private Task<int> Save(params object[] rows) =>
        factory.WithDb(db =>
        {
            db.AddRange(rows);
            return db.SaveChangesAsync();
        });

    private Task<int> Delete(object row) =>
        factory.WithDb(db =>
        {
            db.Remove(row);
            return db.SaveChangesAsync();
        });

    private static string? SqlState(DbUpdateException ex) =>
        (ex.InnerException as PostgresException)?.SqlState;
}
