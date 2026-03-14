# data.example/

This directory shows the structure of `backend/data/` (which is gitignored).

At runtime, the backend creates `backend/data/lablog.db` — a SQLite database with the following tables:

| Table | Key columns |
|---|---|
| `folders` | `id`, `name`, `color` |
| `samples` | `id`, `date`, `substrate`, `notes`, `thickness_nm`, `technique`, `folder_id`, `layers` (JSON), `filenames` (JSON), `area_m2`, `area_correction` |
| `analysis_books` | `id`, `name`, `sample_ids` (JSON) |

Uploaded measurement files are stored in `backend/data/files/<sample_id>/`.

## Techniques

Each sample has a `technique` field set at creation: `"sputter"` or `"pld"`.

### Layer JSON shape — sputter
```json
{
  "id": "abc123",
  "temp": 600,
  "pressure": 10,
  "targets": [
    { "material": "SRO", "oxygen_pct": 10, "power_W": 125, "time_s": 833 },
    { "material": "BTO", "oxygen_pct": 20, "power_W": 150, "time_s": 2300 }
  ]
}
```

### Layer JSON shape — PLD
```json
{
  "id": "def456",
  "temp": 750,
  "pressure": 2,
  "frequency_hz": 10,
  "focal_position": "lens at 45 cm",
  "targets": [
    { "material": "BTO", "energy_mJ": 60, "pulses": 10000 }
  ]
}
```
