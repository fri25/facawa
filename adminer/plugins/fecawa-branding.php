<?php
/**
 * Branding FeCAWa : injecte fecawa-branding.css dans le <head> d'Adminer
 * (méthode head() compatible Adminer 6).
 *
 * @license Apache License, Version 2.0
 */
class AdminerFecawaBranding extends Adminer\Plugin {
	function head($dark = null) {
		echo "<link rel='stylesheet' href='fecawa-branding.css?v=" . crc32((string) @file_get_contents(__DIR__ . "/../fecawa-branding.css")) . "'>\n";
	}
}