namespace TimeTurtle.Api.Auth;

public record LoginRequest(string Email, string Password);

public record ChooseCompany(Guid CompanyId);

public record MeDto(Guid Id, string Email, string Name, Guid? CompanyId);
