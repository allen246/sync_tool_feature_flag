# Deploy To Render

## Files added

- `render.yaml`: Render Blueprint config for a free web service
- `requirements.txt`: includes `gunicorn` for production startup
- `config.py`: reads `PORT`, `HOST`, and `DEBUG` from environment variables

## Deploy steps

1. Push this project to a GitHub repository.
2. Sign in to Render.
3. Click `New +` -> `Blueprint`.
4. Select your GitHub repository.
5. Render will detect `render.yaml`.
6. Confirm the service name and create the service.
7. Wait for the build to finish.
8. Open the generated `.onrender.com` URL.

## Manual setup alternative

If you do not want to use `render.yaml`, create a `Web Service` in Render with:

- Runtime: `Python 3`
- Build Command: `pip install -r requirements.txt`
- Start Command: `gunicorn app:app`
- Plan: `Free`

Optional environment variables:

- `DEBUG=false`
- `HOST=0.0.0.0`

## Notes

- Free Render services spin down after inactivity.
- Uploaded data is not persisted unless you add external storage; this app currently works from request data and local files already in the repo.
