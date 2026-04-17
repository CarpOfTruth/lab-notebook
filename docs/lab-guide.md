# LabLog Operations Guide
## Ferroelectric Thin Film Lab

This guide covers how we use LabLog in this lab. It assumes you have read the user manual and know the basics of navigating the app. What follows is **lab policy** — conventions we follow so that the notebook stays useful as a shared, long-term record.

---

## 1. Sample Naming and Creation

### ID Format

Every sample grown in this lab gets a unique ID: **SP### — three digits, zero-padded, sequential.**

```
SP024, SP025, SP026, SP027 ...
```

IDs are assigned in order of growth date. Before you start a deposition, check the most recent entry in the notebook and take the next number. Do not skip numbers. Do not recycle numbers.

**IDs are never reused.** If a deposition failed, the target cracked, or the sample was destroyed, it still gets an entry. Mark it failed in the name or notes. The record of what went wrong is part of the scientific record.

### Name Field

The name field is for human-readable identification. Use a short, informative description that captures the key details at a glance:

```
BTO on STO, 100nm, 650°C
BTO on STO, 50nm, 600°C, Ar/O2 60/40
LSCO/BTO/LSCO on STO, PLD, 700°C
BTO on Si with STO buffer, sputter
```

The pattern is: **material stack / substrate, thickness, key growth condition**. Include the electrode stack if it's already deposited. If the sample has a buffer layer or seed layer, note it.

Avoid vague names like "BTO test" or "sample 3" — those are meaningless six months later.

### Technique

Select **PLD** or **Sputter** from the technique field. If a sample involved both (e.g., a sputtered bottom electrode with a PLD ferroelectric layer), record the primary ferroelectric growth technique and explain the stack in the notes.

### Notes Field — Use It Immediately

Record anything unusual about growth **the same day**, before you leave the lab. Notes you think you'll remember, you won't. Things to record immediately:

- Target age / number of shots at start of deposition
- Any mid-run anomalies (pressure spike, laser instability, rate drift)
- Actual substrate temperature vs. setpoint if they differed
- Post-deposition anneal conditions if different from standard
- Visual observations (color, surface, cracking)

Example note at sample creation:
> Sputter run, ~100 nm BTO on 5mm STO(001). Ar/O2 = 60/40 sccm, 5 mTorr, 150W RF, chuck at 650°C. Rate confirmed ~1 Å/s from recent calibration (SP021). Small pressure excursion to 7 mTorr at t=20 min, stabilized. Film looks clear/uniform visually.

---

## 2. Folder Organization

### Suggested Structure

Organize by material system or project. Start simple:

```
BTO Sputter
BTO PLD
LSCO electrodes
Substrates
Incoming — uncharacterized
```

"Substrates" is for bare substrate entries that you want to track (e.g., annealed STO substrates that get characterized before film growth). "Incoming — uncharacterized" is a holding folder for samples that are grown but haven't been measured yet — useful for keeping the main folders clean during a busy growth period.

### Don't Over-Organize Early

Folders are cheap to add later. A folder called "BTO Sputter" with 40 samples in it is fine. What's painful is trying to reorganize 200 samples across a dozen folders after the fact. Let the structure emerge from the actual work.

If you're starting a distinct sub-project (e.g., a systematic thickness series funded by a new grant, or a collaboration set), it's reasonable to give it its own folder from the start:

```
BTO thickness series — April 2026
```

But for routine depositions, default to the material-system folders.

### One Sample, One Entry

Do not create duplicate entries for the same physical sample. If you cleave a sample for multiple measurements, the pieces are still SP026. Add sub-entries or multiple data files to the same sample record. If you deposit on multiple substrates in one run and want to track them separately, create separate SP### entries with a note that they came from the same run (e.g., "Co-deposited with SP027, same run conditions").

---

## 3. P-E Loop Module — Standard Workflow

The P-E Loop module is the primary analysis tool for ferroelectric characterization. Use it for every hysteresis measurement. Do not just attach a raw .csv and leave it — run it through the module so the processed result is part of the record.

### Adding the Module

Open the sample entry, go to the Modules section, and add the P-E Loop module. You can add multiple instances if you have multiple devices or measurement conditions for the same sample (e.g., different frequencies or temperatures).

### Uploading Measurement Files

The module accepts **.csv, .dat, .txt, and .pe files**. Upload the raw output from the measurement system directly — do not pre-process in Excel or Origin before uploading. The raw file is the primary record; the module's output is derived from it.

**Name your files before uploading.** The filename is preserved and displayed. Use a clear, descriptive filename:

```
SP026_PE_100kHz_RT.csv
SP026_PE_100kHz_RT_device2.csv
SP031_PE_10kHz_-60to60V.dat
```

Include: sample ID, measurement type, key condition (frequency, voltage range, temperature if not room temperature), and device number if measuring multiple capacitors on the same sample.

### Setting the Device Area — Critical

**The device area input is mandatory and must be set correctly.** All polarization values (µC/cm²) are calculated from this number. A wrong area means wrong polarization values in every output and every analysis book that uses this data.

Measure the capacitor area before or immediately after the measurement. For circular contacts, calculate area from the diameter. For square/rectangular contacts, measure both sides. Record the method (optical microscope, profilometer, nominal mask dimensions) in the module notes if there's any ambiguity.

If you're unsure of the area, record the raw charge data and note the uncertainty — do not guess.

### Checking the Fit Overlay

After uploading and setting the area, the module returns a fit curve overlaid on the measured loop. **Look at this before you move on.** Check that:

- The fit tracks the loop shape reasonably well
- The saturation polarization (P_s) and remnant polarization (P_r) values look physically reasonable for your material
- The coercive field (E_c) is where you expect it from the raw loop

### What Good Data Looks Like

A clean BTO film on STO should show:

- A well-saturated, symmetric loop with sharp switching
- P_r in the range of 5–30 µC/cm² depending on thickness and orientation
- E_c in the range of 50–500 kV/cm depending on thickness and frequency
- Minimal offset (imprint) for a fresh, unpoled sample

### Common Artifacts — Identify and Note Them

**Leaky sample:** The loop opens and does not saturate symmetrically. The apparent polarization increases continuously with voltage. This is resistive current, not switching. Note it: *"Significant leakage, loop not saturated — polarization values unreliable."* Do not report P_r from a leaky loop as a ferroelectric property.

**Incomplete loop (not saturated):** The loop is well-shaped but the voltage range wasn't sufficient to saturate. The loop tips are still curved upward. Increase the voltage range if the device can withstand it, or note that saturation was not reached and the reported P_r is a lower bound.

**Imprint / offset:** The loop is shifted significantly along the voltage axis. This indicates a built-in field, usually from charge trapping, surface chemistry, or asymmetric electrodes. Note the direction and magnitude of the offset. Imprint can be real or an artifact of prior poling history — note whether the sample was previously poled.

**Noisy data at low fields:** Common with small devices or thin films near the noise floor of the measurement system. Note the device area and whether the signal-to-noise ratio is adequate.

### Using Module Output in Analysis Books

The processed loop, P_r, P_s, and E_c values from the module are available when you add this sample to an analysis book. This is the intended workflow for comparing samples across a growth series — see Section 5.

---

## 4. XRD Data — Current Practice

There is no dedicated XRD module yet. Until one is available, attach raw XRD files directly to the sample metadata as file attachments and record observations in the notes field.

### File Attachment

Attach the raw data file from the diffractometer. Use clear filenames:

```
SP026_XRD_omega2theta.xy
SP026_XRD_RSM_103.dat
SP026_XRR.dat
SP031_XRD_omega2theta_postanneal.xy
```

### What to Record in Notes

For every XRD measurement, add a note that specifies:

1. **Scan type**: ω–2θ, RSM, XRR, rocking curve
2. **Peak positions**: Record 2θ values for the film peak(s) and the relevant substrate peak. Example: *"BTO 002 at 2θ = 44.82°, STO 002 at 45.25°. Film is compressively strained."*
3. **Out-of-plane lattice parameter** calculated from the peak position, if you've done it
4. **RSM details**: Which reciprocal lattice point (e.g., 103), whether the film peak is coherent with the substrate
5. **XRR**: Thickness and roughness from the fit, software used, fit quality
6. **Any anomalies**: Extra peaks, peak splitting, broad/absent film peak

Example note:
> XRD ω–2θ: BTO 002 at 44.82° (c = 4.047 Å, tensile vs. bulk 4.038 Å). Substrate STO 002 at 45.25°. Film peak FWHM = 0.18°. No pyrochlore or secondary phase peaks detected. Raw file: SP026_XRD_omega2theta.xy

### RSM Convention

For RSMs, always note the asymmetric reflection measured. We typically use the 103 or 013 reflection for (001)-oriented perovskites. Note whether the film Q_x matches the substrate (pseudomorphic / coherently strained) or is relaxed.

---

## 5. Analysis Books — Recommended Use

### When to Create a Book

Create a book when you are **comparing multiple samples** — a thickness series, a temperature series, a doping series, or any set of samples grown to answer a specific scientific question. Do not create a book for a single sample.

Good triggers for creating a book:
- You've finished growing a series of 4–6 BTO films with varying thickness and want to plot P_r vs. thickness
- You're writing a paper section and need to present data from 8 samples side by side
- A collaborator wants to see comparative results from the last month's growths

### Naming Books

Name books so that another lab member can understand what's in them without opening them:

```
BTO thickness series — April 2026
BTO sputter temperature optimization — Q1 2026
LSCO electrode comparison — SP018 to SP024
BTO on Si — initial feasibility study
```

Include the material system, what variable is being compared, and a date or sample range. Avoid names like "BTO analysis" or "ferroelectric data" — those don't tell anyone anything.

### Exporting for Collaborators

Before sharing a book with a collaborator outside the lab:

1. Export the book from LabLog
2. If the collaborator needs to run analysis themselves (not just view results), include the sample data in the export
3. If you're sharing a finalized result set, export without raw data to keep the file size manageable

Note in the sample records when data has been shared externally and with whom.

---

## 6. Data File Hygiene

### Name Files Before Uploading

The filename is what you and everyone else will see in the notebook. Rename files from instrument-generated names (which are often meaningless strings or sequential numbers) to something informative before you upload.

Bad: `data_0047.csv`, `20260415_143201.dat`, `scan3.xy`

Good: `SP026_PE_100kHz_RT.csv`, `SP026_XRD_omega2theta.xy`, `SP031_XRR_postanneal.dat`

### Include Conditions in the Filename When Instruments Don't

Some instruments embed measurement conditions in the file header; others don't. When in doubt, include the key condition in the filename:

```
SP026_dielectric_1kHz_to_1MHz_RT.csv
SP026_dielectric_biassweep_10kHz_RT.csv
SP031_PE_77K.csv
```

### Do Not Upload Partial or Corrupted Files

If a measurement was interrupted, the instrument crashed, or you suspect the data is bad, do not upload the file. Re-measure. If re-measurement isn't possible, note why in the sample record ("XRR measurement aborted — instrument alignment lost, data incomplete") but do not attach the partial file as if it were complete data.

If you upload a file and later realize it was incorrect (wrong sample ID on the instrument, wrong calibration applied), remove it and upload the correct version. Add a note explaining what happened.

---

## 7. Dielectric and Other Electrical Measurements

There is no dedicated module for dielectric measurements yet. Until one is available, follow the same approach as XRD: attach raw files, record conditions in notes.

### File Attachment

```
SP026_dielectric_freqsweep_0V_RT.csv
SP026_dielectric_biassweep_10kHz_RT.csv
SP026_dielectric_freqsweep_biasfield_RT.csv
```

### What to Record in Notes

For every dielectric measurement, note:

- **Measurement type**: frequency sweep, bias sweep, temperature sweep
- **Frequency range**: e.g., 1 kHz to 1 MHz
- **Bias range**: e.g., –10 V to +10 V, or ±MV/cm if converted
- **AC signal amplitude**
- **Temperature**: room temperature, or specific temperature if variable-temperature
- **Device area** (same as P-E loop — required for calculating permittivity)
- **Key results**: peak permittivity, tunability at 10 kHz, loss tangent at 100 kHz — whatever is relevant to the measurement goal

Example note:
> Dielectric frequency sweep, 0 V DC bias, 1 kHz–1 MHz, RT. Device area 7.07×10⁻⁵ cm² (300 µm diameter). ε_r(10 kHz) ≈ 380, tan δ(10 kHz) ≈ 0.02. No obvious dispersion. Raw file: SP026_dielectric_freqsweep_0V_RT.csv

For **AFM and scanning probe** measurements, attach the image files and note the scan size, mode (contact, tapping, PFM), tip type, and what the image shows. PFM measurements should note the AC voltage amplitude and frequency, and whether you observed switching.

---

## 8. Keeping the Notebook Current

### Enter Samples the Day They're Grown

Create the notebook entry **before or immediately after** a deposition — not the next day, not "when you have time." The entry at creation time should have at minimum: the correct SP### ID, a descriptive name, the technique, and a note with growth conditions.

If you grow a sample on Friday afternoon, the entry goes in on Friday. The notebook is the canonical lab record. An undocumented sample is not a lab sample.

### Upload Data As Soon As It's Collected

Do not batch data uploads. When you finish an XRD run, upload the file and add the note that day. When you finish a P-E measurement, run it through the module that day. The longer data sits on an instrument computer or your laptop, the higher the chance it gets lost, mislabeled, or forgotten.

This is especially important for characterization that happens weeks after growth. If you're measuring SP018 in April and it was grown in January, that data needs to go into the SP018 entry on the day you measure it — not batched with all your other April measurements.

### Notes Are Searchable — Use Them

Notes are not just for your own reference. Future you, your PI, and your labmates can search them. Write notes as if you're leaving a message for someone who wasn't in the lab. Include:

- Numbers (temperatures, pressures, thicknesses, peak positions)
- Observations (what the sample looked like, what the loop shape suggested)
- Decisions (why you chose a particular voltage range, why you stopped at a certain field)
- Concerns (why you think the data might be unreliable)

Vague notes like "looks good" or "measured XRD" are not useful. The notebook is where the science lives. Treat it accordingly.

---

*Last updated: April 2026*
