# Sayanho Web Application

This is the web version of the Sayanho Electrical Diagram Application.

## Project Structure

- **Sayanho.Core**: Shared business logic and models.
- **Sayanho.Backend**: ASP.NET Core Web API.
- **Sayanho.Frontend**: React + Vite application.

## Prerequisites

- .NET 8 SDK
- Node.js (v18 or later)

## Environment Configuration

The application uses environment-specific configuration to support both local development and production deployments.

### Frontend Environment Variables

The frontend uses Vite's environment variable system with two files:

- `.env.development` - Used when running `npm run dev`
- `.env.production` - Used when running `npm run build`

These files configure the `VITE_API_URL` variable to point to the appropriate backend server.

### Backend Configuration

The backend uses ASP.NET Core's `appsettings.json` hierarchy:

- `appsettings.json` - Base configuration
- `appsettings.Development.json` - Development overrides
- `appsettings.Production.json` - Production overrides

Configuration includes logging levels and CORS allowed origins for each environment.

## How to Run Locally

### Backend

1. Navigate to `Sayanho.Backend`:
   ```bash
   cd Sayanho.Backend
   ```
2. Run in Development mode:
   ```bash
   dotnet run --environment Development
   ```
   The API will start at `http://localhost:5000`.

### Frontend

1. Navigate to `Sayanho.Frontend`:
   ```bash
   cd Sayanho.Frontend
   ```
2. Install dependencies (first time only):
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
   The application will be available at `http://localhost:3000`.

The frontend will automatically connect to the local backend using the configuration in `.env.development`.

## Production Build

### Frontend

1. Build the production bundle:
   ```bash
   cd Sayanho.Frontend
   npm run build
   ```
   The built files will be in the `dist/` directory.

2. Preview the production build locally:
   ```bash
   npm run preview
   ```

### Backend

Run the backend in Production mode:
```bash
cd Sayanho.Backend
dotnet run --environment Production
```

When deployed to a hosting service (e.g., Render, Azure), set the `ASPNETCORE_ENVIRONMENT` environment variable to `Production`.

## Features

- **Diagramming**: Drag and drop items from the toolbox, move them on the canvas.
- **Network Analysis**: Run electrical network analysis using the ported C# logic.
- **Save/Load**: Save diagrams to the backend and load them.
- **Private projects**: Create an account to keep cloud projects isolated from other users.

## Accounts and Project Privacy

The backend includes a self-hosted account system with PBKDF2 password hashing, expiring server-side sessions, rate-limited sign-in, and user-specific project directories. The frontend keeps the session token only for the active browser session.

For production, set `AllowedOrigins` to the exact deployed frontend domains and use persistent storage for the backend `Data` directory. The Render free filesystem is ephemeral, so accounts and saved projects will be reset after a redeploy or restart unless you attach persistent storage or move this data to a managed database.

Existing files in `Data/Diagrams` predate user ownership and are intentionally not exposed after enabling accounts. Move any project you need to preserve into the appropriate user's directory only through a trusted administrator process.

## Advertising Slots

Two compact, responsive advertising containers are available on the public landing page: one after the hero and one after the feature showcase. They are deliberately excluded from the designer workspace so ads never cover the canvas, toolbars, dialogs, or component library. Each slot exposes a `data-ad-slot` attribute in `Sayanho.Frontend/src/components/AdSlot.tsx` for your chosen advertising provider.

## Notes

- The backend uses file-based storage for diagrams in `Sayanho.Backend/Data/Diagrams`.
- Icons are served from `Sayanho.Backend/wwwroot/icons` in production or from the external icons directory in development.
- CORS origins are configured per environment in the `appsettings.json` files.
