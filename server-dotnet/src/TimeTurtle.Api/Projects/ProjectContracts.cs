namespace TimeTurtle.Api.Projects;

// An employee's view of a project. It has no rate, by design (DD-031, DD-034).
public record ProjectDto(Guid Id, string Code, string Name, Guid? ClientId, string? ClientName);
