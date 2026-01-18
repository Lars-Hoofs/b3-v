# Web Scraper Fix - Deployment Instructies

## Probleem
De webscraper geeft altijd 0 URLs terug bij de discovery fase in productie.

## Oorzaak
De Alpine-based Docker image mist alle benodigde dependencies voor Puppeteer/Chromium:
- Geen Chromium browser geïnstalleerd
- Geen system libraries die Chromium nodig heeft
- Geen shared memory configuratie in Docker

## Oplossing
We hebben de volgende wijzigingen doorgevoerd:

### 1. Dockerfile geüpdatet
- **Van**: `node:20-alpine` 
- **Naar**: `node:20-slim` (Debian-based)
- **Toegevoegd**: Alle Chromium dependencies en system Chromium
- **Environment variables**: `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` en `PUPPETEER_EXECUTABLE_PATH`

### 2. Scraper Service verbeterd
- Gebruikt nu system Chromium in productie via `executablePath`
- Betere error logging voor debugging
- Browser pool logging om opstartproblemen te traceren

### 3. Docker Compose configuratie
- `shm_size: '2gb'` - Chromium heeft meer shared memory nodig
- `security_opt: seccomp=unconfined` - Voor browser security features
- Environment variables voor Puppeteer paths

## Deployment Stappen

### Stap 1: Rebuild en Deploy
```bash
# Stop de huidige containers
docker-compose -f docker-compose.prod.yml down

# Rebuild de image (met --no-cache om zeker te zijn)
docker-compose -f docker-compose.prod.yml build --no-cache

# Start de services opnieuw
docker-compose -f docker-compose.prod.yml up -d
```

### Stap 2: Controleer de logs
```bash
# Bekijk de API logs
docker logs -f b_ai_api

# Kijk specifiek naar:
# - "Launching browser" berichten
# - "Browser launched successfully" berichten
# - Eventuele Puppeteer errors
```

### Stap 3: Test de scraper
1. Maak een nieuwe scrape job aan via de API
2. Controleer of de status van `DISCOVERING` naar `PENDING` gaat
3. Check of `discoveredUrls` en `totalUrls` > 0 zijn

### Stap 4: Troubleshooting
Als het nog steeds niet werkt:

```bash
# SSH in de container
docker exec -it b_ai_api /bin/bash

# Test of Chromium werkt
/usr/bin/chromium --version

# Check of alle dependencies er zijn
ldd /usr/bin/chromium | grep "not found"

# Bekijk de Puppeteer executable path
echo $PUPPETEER_EXECUTABLE_PATH
```

## Verwachte Resultaten
- De browser moet succesvol opstarten in de container
- URL discovery moet meerdere URLs vinden (niet 0)
- Logs moeten "Browser launched successfully" tonen
- Scrape jobs moeten correct URLs discoveren

## Extra Info
**Image size**: De nieuwe image zal groter zijn (~500MB vs ~150MB) door Chromium en dependencies, maar dit is noodzakelijk voor de scraper functionaliteit.

**Memory**: Zorg dat je server voldoende RAM heeft (minimaal 2GB vrij voor de API container).

**Alternative**: Als de image te groot wordt, kun je overwegen om een aparte scraper service te maken met een dedicated Puppeteer container.
