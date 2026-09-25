using Microsoft.EntityFrameworkCore;

namespace TimeTurtle.Api.Data;

public class Client
{
    public Guid Id { get; set; }
    public required string Name { get; set; }
    public bool Archived { get; set; }
}

public class TurtleDb(DbContextOptions<TurtleDb> options) : DbContext(options)
{
    public DbSet<Client> Clients => Set<Client>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Client>().HasIndex(c => c.Name).IsUnique().HasFilter("Archived NOT TRUE"); // (2)
    }
}
