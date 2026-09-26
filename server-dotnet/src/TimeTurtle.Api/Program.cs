using Microsoft.EntityFrameworkCore;
using Npgsql;
using TimeTurtle.Api.Clients;
using TimeTurtle.Api.Data;

var builder = WebApplication.CreateBuilder(args);

var connectionString =
    builder.Configuration.GetConnectionString("turtle")
    ?? throw new InvalidOperationException("The connection string is not set");

builder.Services.AddNpgsqlDataSource(connectionString);
builder.Services.AddDbContext<TurtleDb>(o =>
    o.UseNpgsql(connectionString).UseSnakeCaseNamingConvention()
);

var app = builder.Build();

app.MapGet(
    "/api/health",
    async (NpgsqlDataSource db) =>
    {
        try
        {
            await using var cmd = db.CreateCommand("SELECT 1");
            await cmd.ExecuteScalarAsync();
            return Results.Ok(new { ok = true });
        }
        catch (NpgsqlException ex) when (ex.IsTransient)
        {
            return Results.Json(new { ok = false }, statusCode: 503);
        }
    }
);

app.MapGet(
    "/api/clients",
    async (TurtleDb db) =>
    {
        return await db
            .Clients.Where(c => !c.Archived)
            .OrderBy(c => c.Name)
            .Select(c => new ClientDto(c.Id, c.Name))
            .ToListAsync();
    }
);

app.MapPost(
    "/api/clients",
    async (NewClient req, TurtleDb db) =>
    {
        if (string.IsNullOrWhiteSpace(req.Name))
        {
            return Results.ValidationProblem(
                new Dictionary<string, string[]> { ["name"] = ["The name cannot be empty"] }
            );
        }
        try
        {
            var client = new Client { Name = req.Name.Trim() };
            db.Add(client);
            await db.SaveChangesAsync();
            return Results.Created(
                $"/api/clients/{client.Id}",
                new ClientDto(client.Id, client.Name)
            );
        }
        catch (DbUpdateException ex)
            when (ex.InnerException
                    is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation }
            )
        {
            return Results.Conflict();
        }
    }
);

app.Run();
