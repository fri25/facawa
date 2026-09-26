# =============================================================================
# Image Adminer personnalisée — branding FeCAWa
# =============================================================================
# Basée sur l'image officielle (support SQLite inclus), on y ajoute :
#   - le logo FeCAWa (fecawa-logo.jpeg)
#   - une feuille de style de marque (fecawa-branding.css)
#   - un plugin qui injecte cette feuille dans le <head> d'Adminer
#
# Contexte de build : racine du dépôt (./adminer/Dockerfile).
# =============================================================================
# Version ÉPINGLÉE : `latest` rend les mises à jour subies et les régressions
# impossibles à corréler (le plugin `fecawa-sqlite-auto` s'appuie sur la
# signature `login(string,string): bool` de `Adminer\Plugin`, introduite en
# Adminer 5 : un saut de version majeur casserait silencieusement
# l'auto-connexion). Version constatée en place le 2026-09-26 : 6.1.1.
FROM adminer:6.1.1

COPY logo_new.jpeg /var/www/html/fecawa-logo.jpeg
COPY adminer/fecawa-branding.css /var/www/html/fecawa-branding.css
COPY adminer/plugins/fecawa-branding.php /var/www/html/plugins/fecawa-branding.php
COPY adminer/plugins/fecawa-sqlite-auto.php /var/www/html/plugins/fecawa-sqlite-auto.php