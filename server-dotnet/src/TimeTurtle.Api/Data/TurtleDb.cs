using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
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
    public Guid SecurityStamp { get; set; } = Guid.NewGuid();
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

public class Project
{
    public Guid Id { get; set; }
    public Guid CompanyId { get; set; }
    public Guid? ClientId { get; set; }
    public required string Code { get; set; }
    public required string Name { get; set; }
    public bool Archived { get; set; }
}

// One person on one project. It has no dates: ending it sets EndedAt and never deletes it (DD-032).
public class Assignment
{
    public Guid Id { get; set; }
    public Guid MembershipId { get; set; }
    public Guid ProjectId { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
}

// The only rate (DD-031). A new rate is a new row from a date.
public class AssignmentRate
{
    public Guid Id { get; set; }
    public Guid AssignmentId { get; set; }
    public DateOnly ValidFrom { get; set; }
    public decimal Rate { get; set; }
}

public class TurtleDb(DbContextOptions<TurtleDb> options, CurrentUser me)
    : DbContext(options),
        IDataProtectionKeyContext
{
    public DbSet<Company> Companies => Set<Company>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<Client> Clients => Set<Client>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<Assignment> Assignments => Set<Assignment>();
    public DbSet<AssignmentRate> AssignmentRates => Set<AssignmentRate>();
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

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

        model.Entity<Project>().HasQueryFilter(p => p.CompanyId == _companyId);
        model
            .Entity<Project>()
            .HasOne<Company>()
            .WithMany()
            .HasForeignKey(p => p.CompanyId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<Project>()
            .HasOne<Client>()
            .WithMany()
            .HasForeignKey(p => p.ClientId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<Project>()
            .HasIndex(p => new { p.CompanyId, p.Code })
            .IsUnique()
            .HasFilter("NOT archived");

        // An assignment has no company column. It belongs to the company of its project.
        model.Entity<Assignment>().HasQueryFilter(a => Projects.Any(p => p.Id == a.ProjectId));
        model
            .Entity<Assignment>()
            .HasOne<Membership>()
            .WithMany()
            .HasForeignKey(a => a.MembershipId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<Assignment>()
            .HasOne<Project>()
            .WithMany()
            .HasForeignKey(a => a.ProjectId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<Assignment>()
            .HasIndex(a => new { a.MembershipId, a.ProjectId })
            .IsUnique()
            .HasFilter("ended_at IS NULL");

        model
            .Entity<AssignmentRate>()
            .HasQueryFilter(r => Assignments.Any(a => a.Id == r.AssignmentId));
        model
            .Entity<AssignmentRate>()
            .HasOne<Assignment>()
            .WithMany()
            .HasForeignKey(r => r.AssignmentId)
            .OnDelete(DeleteBehavior.Restrict);
        model
            .Entity<AssignmentRate>()
            .HasIndex(r => new { r.AssignmentId, r.ValidFrom })
            .IsUnique();
        model.Entity<AssignmentRate>().Property(r => r.Rate).HasColumnType("numeric");
    }
}
