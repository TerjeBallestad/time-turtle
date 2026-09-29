using Microsoft.EntityFrameworkCore;
using TimeTurtle.Api.Auth;

namespace TimeTurtle.Api.Data;

public class Company
{
    public Guid Id { get; set; }
    public required string Name { get; set; }
}

public class User
{
    public Guid Id { get; set; }
    public required string Email { get; set; }
    public required string Name { get; set; }
    public required string PasswordHash { get; set; }
}

public class Membership
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid CompanyId { get; set; }
}

public class Client
{
    public Guid Id { get; set; }
    public Guid CompanyId { get; set; }
    public required string Name { get; set; }
    public bool Archived { get; set; }
}

public class TurtleDb(DbContextOptions<TurtleDb> options, CurrentUser me) : DbContext(options)
{
    public DbSet<Company> Companies => Set<Company>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<Client> Clients => Set<Client>();

    private readonly Guid? _companyId = me.CompanyId;

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<User>().HasIndex(u => u.Email).IsUnique();

        model
            .Entity<Membership>()
            .HasOne<User>()
            .WithMany()
            .HasForeignKey(m => m.UserId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<Membership>()
            .HasOne<Company>()
            .WithMany()
            .HasForeignKey(m => m.CompanyId)
            .OnDelete(DeleteBehavior.Restrict);
        model.Entity<Membership>().HasIndex(m => new { m.CompanyId, m.UserId }).IsUnique();

        model.Entity<Client>().HasQueryFilter(c => c.CompanyId == _companyId);
        model
            .Entity<Client>()
            .HasOne<Company>()
            .WithMany()
            .HasForeignKey(c => c.CompanyId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<Client>()
            .HasIndex(c => new { c.CompanyId, c.Name })
            .IsUnique()
            .HasFilter("NOT archived");
    }
}
