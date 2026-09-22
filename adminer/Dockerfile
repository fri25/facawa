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
FROM adminer:latest

COPY logo_new.jpeg /var/www/html/fecawa-logo.jpeg
COPY adminer/fecawa-branding.css /var/www/html/fecawa-branding.css
COPY adminer/plugins/fecawa-branding.php /var/www/html/plugins/fecawa-branding.php
COPY adminer/plugins/fecawa-sqlite-auto.php /var/www/html/plugins/fecawa-sqlite-auto.php