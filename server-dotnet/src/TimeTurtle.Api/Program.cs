using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using TimeTurtle.Api.Auth;
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

builder
    .Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
        o.Events.OnRedirectToLogin = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        }
    );
builder.Services.AddAuthorization();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<PasswordHasher<User>>();
builder.Services.AddScoped<CurrentUser>();

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

app.MapPost(
    "/api/login",
    async (LoginRequest request, TurtleDb db, PasswordHasher<User> hasher) =>
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Email == request.Email);
        if (user == null)
        {
            return Results.Unauthorized();
        }

        var check = hasher.VerifyHashedPassword(user, user.PasswordHash, request.Password);
        if (check == PasswordVerificationResult.Failed)
        {
            return Results.Unauthorized();
        }
        var companyIds = await db
            .Memberships.Where(m => m.UserId == user.Id)
            .Select(m => m.CompanyId)
            .ToListAsync();

        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, user.Id.ToString()) };

        if (companyIds.Count == 1)
        {
            claims.Add(new("company", companyIds[0].ToString()));
        }
        return SignIn(claims);
    }
);

app.MapGet(
        "/api/me",
        async (TurtleDb db, CurrentUser me) =>
        {
            var meUser = await db.Users.SingleOrDefaultAsync(u => u.Id == me.UserId);
            if (meUser == null)
            {
                return Results.Unauthorized();
            }

            return Results.Ok(new MeDto(meUser.Id, meUser.Email, meUser.Name, me.CompanyId));
        }
    )
    .RequireAuthorization();

app.MapPost(
        "/api/session/company",
        async (ChooseCompany request, TurtleDb db, CurrentUser me) =>
        {
            bool isMember = await db.Memberships.AnyAsync(m =>
                m.CompanyId == request.CompanyId && m.UserId == me.UserId
            );

            if (!isMember)
            {
                return Results.Forbid();
            }

            var claims = new List<Claim>
            {
                new(ClaimTypes.NameIdentifier, me.UserId.ToString()!),
                new("company", request.CompanyId.ToString()),
            };
            return SignIn(claims);
        }
    )
    .RequireAuthorization();

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
    )
    .RequireAuthorization(p => p.RequireClaim("company"));

app.MapPost(
        "/api/clients",
        async (NewClient req, TurtleDb db, CurrentUser me) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name))
            {
                return Results.ValidationProblem(
                    new Dictionary<string, string[]> { ["name"] = ["The name cannot be empty"] }
                );
            }
            try
            {
                var client = new Client { Name = req.Name.Trim(), CompanyId = me.CompanyId!.Value };
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
    )
    .RequireAuthorization(p => p.RequireClaim("company"));

app.Run();

static IResult SignIn(List<Claim> claims) =>
    Results.SignIn(
        new ClaimsPrincipal(
            new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme)
        )
    );
