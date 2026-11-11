// nowcast/credits.js - every model, piece of code, data source and map in the app, with its licence and the credit it asks for.
// v014: the other counties' data (Douglas County's lot lines; Lane's and Douglas's drainages, outlines and public land), checked at source Nov-08-2026.
// v018: the forecast maps (nowcast/fields/: NOAA HRRR read live), NODD terms checked at registry.opendata.aws/noaa-hrrr-pds Nov-09-2026.
'use strict';

export const CREDITS = [
  {
    title: 'Forecast models',
    items: [
      {
        name: 'BEAM (Blended Early-warning Alert Model)',
        text: 'Created by artist Josh Hughes for this app as a public-good project, released under the Apache License 2.0 with a NOTICE crediting him. The example storms are recorded BEAM forecasts shown with NOAA MRMS radar and NOAA GOES-West GLM lightning (the Aug 11, 2022 Wallowa hailstorm from BEAM’s blind test).',
        links: [['Apache License 2.0', 'licenses/Apache-2.0.txt'], ['Notice', 'licenses/BEAM-NOTICE.txt']]
      },
      {
        name: 'NVIDIA StormScope',
        text: 'Licensed by NVIDIA Corporation under the NVIDIA Open Model License. Modified for this app: quantised to 8-bit integers and run as WebGPU kernels; the satellite input is held at its newest image. Its example storms are StormScope forecasts recorded on a computer with the full-precision model, from NOAA MRMS radar and NOAA GOES-East satellite and lightning.',
        links: [
          ['The licence (full text)', 'licenses/NVIDIA-Open-Model-License.txt'],
          ['Notice', 'licenses/NOTICE.txt'],
          ["NVIDIA's page", 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'],
          ['The model', 'https://huggingface.co/nvidia/stormscope-goes-mrms']
        ]
      },
      {
        name: 'DeepMind DGMR',
        text: 'Copyright 2021 DeepMind Technologies Limited. Licensed under CC BY 4.0. Modified: the weights converted to 16-bit floats (the full model) or quantised to 8-bit integers (the low-memory model), and run as WebGPU kernels. Its example storms are DGMR forecasts recorded with this app’s own engine from NOAA MRMS radar.',
        links: [
          ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
          ['The source', 'https://github.com/google-deepmind/deepmind-research/tree/master/nowcasting']
        ]
      }
    ]
  },
  {
    title: 'Code from others',
    items: [
      {
        name: 'NVIDIA Earth2Studio',
        text: 'Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES. Licensed under the Apache License 2.0. StormScope\'s input preparation and network are re-implemented in JavaScript from it, with changes for a phone.',
        links: [
          ['Apache License 2.0', 'licenses/Apache-2.0.txt'],
          ['The source', 'https://github.com/NVIDIA/earth2studio']
        ]
      },
      {
        name: 'climt solar angle (via NVIDIA PhysicsNeMo)',
        text: 'Copyright (c) 2016, Rodrigo Caballero. BSD license.',
        links: [
          ['The notice', 'licenses/BSD-3-Clause-climt.txt']
        ]
      }
    ]
  },
  {
    title: 'Weather data',
    items: [
      {
        name: 'Stream gauges: US Geological Survey (USGS Water Data)',
        text: 'Public domain (US Government work). Recent values are provisional: they have not been reviewed and may be revised.',
        links: [['USGS Water Data APIs', 'https://api.waterdata.usgs.gov/']]
      },
      {
        name: 'Current fires: National Interagency Fire Center (WFIGS)',
        text: 'US Department of Interior Office of Wildland Fire: IRWIN, USDA Forest Service, National Park Service, Fish and Wildlife Service, Bureau of Indian Affairs, and Bureau of Land Management, National Association of State Foresters, US Fire Administration, National Wildfire Coordinating Group. Not legal documents; the data change as the agencies report them, and NIFC gives no warranty.',
        links: [['Fire locations', 'https://www.arcgis.com/home/item.html?id=4181a117dc9e43db8598533e29972015'], ['Fire perimeters', 'https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824']]
      },
      {
        name: 'Radar, hail size and rain: NOAA MRMS',
        text: 'NOAA open data (NOAA Open Data Dissemination).',
        links: []
      },
      {
        name: 'Satellite and lightning: NOAA GOES-East ABI and GLM',
        text: 'NOAA open data (NOAA Open Data Dissemination).',
        links: []
      },
      {
        name: 'Satellite and lightning for BEAM: NOAA GOES-West (GOES-18) ABI band 13 and GLM',
        text: 'NOAA open data (NOAA Open Data Dissemination).',
        links: []
      },
      {
        name: 'Rain, snow, sleet and freezing rain type: NOAA HRRR',
        text: 'NOAA open data (NOAA Open Data Dissemination).',
        links: []
      },
      {
        name: 'Forecasts (wind, temperature, humidity, pressure, precipitation): NOAA HRRR',
        text: "NOAA open data (NOAA Open Data Dissemination), read live from NOAA's HRRR model on AWS (its hourly and 15-minute files). Modified for this app: regridded to the map, blended between the hours (wind, temperature, humidity and pressure, shown every 15 minutes), converted to the app's units (mph, °F, in/h, hPa) and coloured, so the maps are not original, unaltered NOAA data. A model forecast (Experimental), not an official forecast or warning; NOAA does not endorse this app.",
        links: []
      },
      {
        name: 'Warnings and forecasts: US National Weather Service',
        text: 'Public information from api.weather.gov.',
        links: []
      },
      {
        name: 'Clouds: NASA GIBS',
        text: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
        links: []
      },
      {
        name: 'Satellite: NOAA GOES-West and GOES-East ABI via NASA GIBS',
        text: "GeoColor imagery provided by NOAA/NESDIS/STAR. Band 13 drawn in this app's own colours. No endorsement.",
        links: []
      }
    ]
  },
  {
    title: 'Maps',
    items: [
      {
        name: 'Drainages: USGS Watershed Boundary Dataset (WBD)',
        text: '12-digit hydrologic units (HUC-12) that reach into Wallowa, Lane and Douglas counties. Modified for this app: Pacific Ocean units and rocks under 1 hectare left out; shared boundaries simplified to about 30 m and rounded to 0.0001 degree. For display: not for site-specific or regulatory decisions.',
        links: []
      },
      {
        name: 'Imagery: USDA, USGS The National Map: Orthoimagery',
        text: 'US government work.',
        links: []
      },
      {
        name: 'Topo: USGS The National Map',
        text: 'USGS The National Map: National Boundaries Dataset, 3DEP Elevation Program, Geographic Names Information System, National Hydrography Dataset, National Land Cover Database, National Structures Dataset, and National Transportation Dataset; USGS Global Ecosystems; U.S. Census Bureau TIGER/Line data; USFS Road data; Natural Earth Data; U.S. Department of State HIU; NOAA National Centers for Environmental Information.',
        links: []
      },
      {
        name: 'Relief: USGS The National Map: 3D Elevation Program',
        text: 'USGS Earth Resources Observation & Science (EROS) Center: GMTED2010.',
        links: []
      },
      {
        name: 'Oregon imagery 2022: Oregon Statewide Imagery Program (OSIP) - Oregon Imagery Framework Implementation Team',
        text: "Oregon's public imagery service.",
        links: []
      },
      {
        name: 'Lot lines: Wallowa County',
        text: "From Wallowa County's public map; also used to count the properties in an app alert's zone. Not a survey or a legal record.",
        links: []
      },
      {
        name: 'Lot lines: Douglas County',
        text: 'From Douglas County’s public map (its ORMAP tax lot layer); also used to count the properties in an app alert’s zone. The county provides its maps as an informational convenience only and is not liable for errors. Not a survey or a legal record.',
        links: [['The layer', 'https://gis.co.douglas.or.us/portal/home/item.html?id=257f942a445a4c8c93df2d90e8c60673']]
      },
      {
        name: 'Roads: USGS The National Map: National Transportation Dataset; U.S. Census Bureau - TIGER/Line; U.S. Forest Service',
        text: 'Public domain. Not a record of which roads are open: forest roads can be closed, gated or impassable.',
        links: []
      },
      {
        name: 'Public land: Bureau of Land Management, National Operation Center',
        text: "Forest Service and BLM land from the BLM's Surface Management Agency data (public data); the BLM is the source. Modified for this app: clipped to the app's county areas and simplified to about 25 m. Not a legal document or a land survey, and not endorsed by the BLM.",
        links: []
      },
      {
        name: 'Wilderness: US Forest Service Enterprise Map Service Program',
        text: "Wilderness boundaries. Modified for this app: clipped to the app's county areas and simplified to about 25 m. Not a legal document.",
        links: []
      },
      {
        name: 'Places and boundary lines: US Census Bureau',
        text: 'Gazetteer files, population estimates (Vintage 2024 for cities and towns; American Community Survey 2020-2024 5-year, table B01003, for census-designated places), cartographic boundaries and TIGER/Line county boundaries (public domain). County boundaries simplified to about 60 m.',
        links: []
      },
      {
        name: 'Small places in the app’s counties: USGS Geographic Names Information System (GNIS)',
        text: 'Populated places in Wallowa, Lane and Douglas counties that are not Census places, for the map’s place names (public domain). Positions kept to 0.01 degree.',
        links: []
      }
    ]
  }
];

export const CREDITS_FOOT = 'None of these organisations endorses this app. For warnings, follow the National Weather Service.';

export function creditsNode(doc = document) {
  const frag = doc.createDocumentFragment();
  for (const section of CREDITS) {
    const h3 = doc.createElement('h3');
    h3.className = 'credits-h';
    h3.textContent = section.title;
    frag.append(h3);
    for (const item of section.items) {
      const p = doc.createElement('p');
      p.className = 'footnote credits-item';
      const b = doc.createElement('b');
      b.textContent = item.name;
      p.append(b, doc.createTextNode(': ' + item.text));
      let first = true;
      for (const [label, href] of item.links) {
        p.append(doc.createTextNode(first ? ' ' : ' · '));
        const a = doc.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = label;
        p.append(a);
        first = false;
      }
      frag.append(p);
    }
  }
  const foot = doc.createElement('p');
  foot.className = 'footnote';
  foot.textContent = CREDITS_FOOT;
  frag.append(foot);
  return frag;
}
