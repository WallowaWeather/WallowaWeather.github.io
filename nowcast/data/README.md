us_lines.bin: state lines, county lines and the outline (coast, Great Lakes shore, Canada and Mexico borders) of the lower 48 states and DC, for the rain map (read by nowcast/lines.js).
Source: https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip (sha256 a867f8734059b45d1d54a0ba56189dd7e73c42eb451418fa56de44c35232614b).
This is US Census Bureau cartographic boundary data, a US government work in the public domain, simplified to about 200-250 m and 0.001 degree.

beam_recal.json (v009): BEAM's frozen hail recalibration, two tables of 100 values (radar as is, and the radar-hidden fallback). The live
BEAM layer shows hail through it (raw chance in 1 % bins -> the chance to show); core, lightning and cloudburst are shown raw, and the
warning outlines stay at the raw frozen levels. Copied word for word from the BEAM backtest's RECAL.json (frozen Nov-07-2026);
never edited here.

v014 (the app's other counties, nowcast/counties.js; built Nov-08-2026 from the same public sources, see nowcast/credits.js):
county_<id>.json: each county's outline ({ name, geoid, source, made, rings }, [lon, lat], even-odd), US Census Bureau TIGER/Line counties
(TIGERweb State_County layer 1), simplified to about 60 m; Lane's and Douglas's tell their overlapping boxes apart (Wallowa's is not wired:
its box decides, as before). huc12_lane.json, huc12_douglas.json: the HUC-12 drainages that reach into Lane and Douglas counties, in
huc12_wallowa.json's format (USGS WBD; Pacific Ocean units and rocks under 1 ha left out). lands_lane.json, lands_douglas.json: public land
and wilderness around Lane and Douglas counties, in ../public_lands.json's format (BLM SMA, USFS wilderness; each county box + 0.1 degree).

v018 place_pop.txt.gz (219 KB, read once by nowcast/labels.js for the map's city names): how many people live in each place of
places/data/places_us.txt.gz, by state and name, so the map names cities by their people (the place table's own size is the land area
of a census-designated place, which put big empty CDPs ahead of real cities). US Census Bureau, public domain: Vintage 2024 population
estimates for cities and towns (SUB-EST2024, POPESTIMATE2024), American Community Survey 2020-2024 5-year estimates for census-designated
places (table B01003), names matched by GEOID through the 2025 Gazetteer. Lines starting with + are the app's counties' (Wallowa, Lane,
Douglas) populated places that are not Census places (Imnaha, Troy, McKenzie Bridge, Tiller ...): USGS Geographic Names Information
System (GNIS) Domestic Names for Oregon (public domain; use constraints none), kept to 0.01 degree; historical places, subdivisions,
names a Census place within 15 km already has, and points inside a Census place's own area are left out.
