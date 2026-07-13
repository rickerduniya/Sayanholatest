using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Sayanho.Backend.Services;

public sealed class AuthenticationService
{
    private const int PasswordIterations = 210_000;
    private const int PasswordHashLength = 32;
    private readonly string _connectionString;

    public AuthenticationService(IWebHostEnvironment environment)
    {
        var dataDirectory = Path.Combine(environment.ContentRootPath, "Data");
        Directory.CreateDirectory(dataDirectory);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(dataDirectory, "auth.db"),
            Mode = SqliteOpenMode.ReadWriteCreate
        }.ToString();

        InitializeDatabase();
    }

    public AuthenticationResult Register(string email, string password, string? displayName)
    {
        var normalizedEmail = NormalizeEmail(email);
        ValidateRegistration(normalizedEmail, password);

        var user = new AuthenticatedUser(Guid.NewGuid().ToString(), normalizedEmail, NormalizeDisplayName(displayName, normalizedEmail));
        var salt = RandomNumberGenerator.GetBytes(16);
        var passwordHash = HashPassword(password, salt);

        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
            VALUES ($id, $email, $displayName, $passwordHash, $passwordSalt, $createdAt);
            """;
        command.Parameters.AddWithValue("$id", user.Id);
        command.Parameters.AddWithValue("$email", user.Email);
        command.Parameters.AddWithValue("$displayName", user.DisplayName);
        command.Parameters.AddWithValue("$passwordHash", passwordHash);
        command.Parameters.AddWithValue("$passwordSalt", salt);
        command.Parameters.AddWithValue("$createdAt", DateTimeOffset.UtcNow.ToString("O"));

        try
        {
            command.ExecuteNonQuery();
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
        {
            throw new AuthenticationException("An account with this email already exists.");
        }

        return CreateSession(connection, user);
    }

    public AuthenticationResult Login(string email, string password)
    {
        var normalizedEmail = NormalizeEmail(email);
        if (string.IsNullOrEmpty(normalizedEmail) || string.IsNullOrEmpty(password))
        {
            throw new AuthenticationException("Invalid email or password.");
        }

        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, email, display_name, password_hash, password_salt
            FROM users
            WHERE email = $email
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$email", normalizedEmail);

        AuthenticatedUser user;
        using (var reader = command.ExecuteReader())
        {
            if (!reader.Read())
            {
                throw new AuthenticationException("Invalid email or password.");
            }

            var storedHash = (byte[])reader[3];
            var storedSalt = (byte[])reader[4];
            if (!VerifyPassword(password, storedSalt, storedHash))
            {
                throw new AuthenticationException("Invalid email or password.");
            }

            user = new AuthenticatedUser(reader.GetString(0), reader.GetString(1), reader.GetString(2));
        }

        return CreateSession(connection, user);
    }

    public AuthenticatedUser? GetUser(string token)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 256)
        {
            return null;
        }

        using var connection = OpenConnection();
        RemoveExpiredSessions(connection);
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT users.id, users.email, users.display_name
            FROM sessions
            INNER JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = $tokenHash
              AND sessions.expires_at > $now
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$tokenHash", HashToken(token));
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));

        using var reader = command.ExecuteReader();
        return reader.Read() ? new AuthenticatedUser(reader.GetString(0), reader.GetString(1), reader.GetString(2)) : null;
    }

    public void Logout(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return;
        }

        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM sessions WHERE token_hash = $tokenHash;";
        command.Parameters.AddWithValue("$tokenHash", HashToken(token));
        command.ExecuteNonQuery();
    }

    private AuthenticationResult CreateSession(SqliteConnection connection, AuthenticatedUser user)
    {
        RemoveExpiredSessions(connection);
        var token = CreateToken();
        var expiresAt = DateTimeOffset.UtcNow.AddDays(14);
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
            VALUES ($tokenHash, $userId, $expiresAt, $createdAt);
            """;
        command.Parameters.AddWithValue("$tokenHash", HashToken(token));
        command.Parameters.AddWithValue("$userId", user.Id);
        command.Parameters.AddWithValue("$expiresAt", expiresAt.ToString("O"));
        command.Parameters.AddWithValue("$createdAt", DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();

        return new AuthenticationResult(token, user, expiresAt);
    }

    private void InitializeDatabase()
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                display_name TEXT NOT NULL,
                password_hash BLOB NOT NULL,
                password_salt BLOB NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
            """;
        command.ExecuteNonQuery();
    }

    private SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys = ON;";
        command.ExecuteNonQuery();
        return connection;
    }

    private static void RemoveExpiredSessions(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM sessions WHERE expires_at <= $now;";
        command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    private static void ValidateRegistration(string email, string password)
    {
        if (string.IsNullOrWhiteSpace(email) || email.Length > 254 || !email.Contains('@'))
        {
            throw new AuthenticationException("Enter a valid email address.");
        }

        if (password.Length < 12 || password.Length > 256)
        {
            throw new AuthenticationException("Use a password with 12 to 256 characters.");
        }
    }

    private static string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

    private static string NormalizeDisplayName(string? displayName, string email)
    {
        var value = string.IsNullOrWhiteSpace(displayName) ? email.Split('@')[0] : displayName.Trim();
        return value.Length > 80 ? value[..80] : value;
    }

    private static byte[] HashPassword(string password, byte[] salt) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, PasswordIterations, HashAlgorithmName.SHA512, PasswordHashLength);

    private static bool VerifyPassword(string password, byte[] salt, byte[] expectedHash) =>
        CryptographicOperations.FixedTimeEquals(HashPassword(password, salt), expectedHash);

    private static string CreateToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(48))
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

    private static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}

public sealed record AuthenticatedUser(string Id, string Email, string DisplayName);
public sealed record AuthenticationResult(string Token, AuthenticatedUser User, DateTimeOffset ExpiresAt);

public sealed class AuthenticationException : Exception
{
    public AuthenticationException(string message) : base(message)
    {
    }
}
