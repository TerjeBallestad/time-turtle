namespace TimeTurtle.Api.Clients;

public record NewClient(string Name);

public record ClientDto(Guid Id, string Name);
