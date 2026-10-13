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
    public async Task An_archived_project_frees_its_code()
    {
        var old = NewProject("REUSE");
        old.Archived = true;
        await Save(old);
        await Save(NewProject("REUSE"));
    }

    [Fact]
    public async Task Two_companies_may_use_the_same_code()
    {
        await Save(NewProject("SHARED"));
        await Save(NewProject("SHARED", factory.Other));
    }

    [Fact]
    public async Task A_second_active_assignment_for_one_person_on_one_project_is_refused()
    {
        var project = NewProject("TWICE");
        var ada = await factory.MembershipOf("ada@turtle.test", factory.Turtle);
        await Save(project, new Assignment { MembershipId = ada, ProjectId = project.Id });
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() =>
            Save(new Assignment { MembershipId = ada, ProjectId = project.Id })
        );
        Assert.Equal(PostgresErrorCodes.UniqueViolation, SqlState(ex));
    }

    [Fact]
    public async Task An_ended_assignment_allows_a_new_one()
    {
        var project = NewProject("AGAIN");
        var ada = await factory.MembershipOf("ada@turtle.test", factory.Turtle);
        await Save(
            project,
            new Assignment
            {
                MembershipId = ada,
                ProjectId = project.Id,
                EndedAt = DateTimeOffset.UtcNow,
            }
        );
        await Save(new Assignment { MembershipId = ada, ProjectId = project.Id });
    }

    [Fact]
    public async Task A_project_with_an_assignment_cannot_be_deleted()
    {
        var project = NewProject("KEEP");
        var ada = await factory.MembershipOf("ada@turtle.test", factory.Turtle);
        await Save(project, new Assignment { MembershipId = ada, ProjectId = project.Id });

        var ex = await Assert.ThrowsAsync<DbUpdateException>(() =>
            factory.WithDb(db =>
            {
                db.Remove(project);
                return db.SaveChangesAsync();
            })
        );
        // ON DELETE RESTRICT answers 23001, not the 23503 of a missing parent on insert.
        Assert.Equal(PostgresErrorCodes.RestrictViolation, SqlState(ex));
    }

    [Fact]
    public async Task Two_rates_from_the_same_date_are_refused()
    {
        var project = NewProject("PRICE");
        var ada = await factory.MembershipOf("ada@turtle.test", factory.Turtle);
        var assignment = new Assignment
        {
            Id = Guid.CreateVersion7(),
            MembershipId = ada,
            ProjectId = project.Id,
        };
        var day = new DateOnly(2026, 10, 1);
        await Save(
            project,
            assignment,
            new AssignmentRate
            {
                AssignmentId = assignment.Id,
                ValidFrom = day,
                Rate = 1250.50m,
            }
        );
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() =>
            Save(
                new AssignmentRate
                {
                    AssignmentId = assignment.Id,
                    ValidFrom = day,
                    Rate = 1300m,
                }
            )
        );
        Assert.Equal(PostgresErrorCodes.UniqueViolation, SqlState(ex));
    }

    private Project NewProject(string code, Company? company = null) =>
        new()
        {
            Id = Guid.CreateVersion7(),
            CompanyId = (company ?? factory.Turtle).Id,
            Code = code,
            Name = code,
        };

    private Task<int> Save(params object[] rows) =>
        factory.WithDb(db =>
        {
            db.AddRange(rows);
            return db.SaveChangesAsync();
        });

    private static string? SqlState(DbUpdateException ex) =>
        (ex.InnerException as PostgresException)?.SqlState;
}
