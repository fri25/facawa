<?php
/**
 * Auto-login SQLite : pré-remplit le formulaire de connexion Adminer
 * (driver SQLite, base /app/data/fecawa.db, champs vides) pour que l'admin
 * n'ait plus rien à saisir.
 *
 * @license Apache License, Version 2.0
 */
class AdminerFecawaSqliteAutoLogin extends Adminer\Plugin {
	const SQLITE_DB = "/app/data/fecawa.db";

	function login(string $login, string $password) {
		if (\Adminer\DRIVER === "sqlite") {
			return true; // SQLite n'a pas de mot de passe : la protection est assurée en amont par le basic-auth Traefik
		}
		return null; // autre driver → vérification Adminer d'origine
	}

	function loginFormField(string $name, string $heading, string $value): string {
		if ($name === "driver") {
			return $heading
				. "SQLite\n"
				. "<input type='hidden' name='auth[driver]' value='sqlite'>\n";
		}
		if ($name === "db") {
			return $heading
				. Adminer\h(self::SQLITE_DB) . "\n"
				. "<input type='hidden' name='auth[db]' value='" . Adminer\h(self::SQLITE_DB) . "'>\n";
		}
		if (in_array($name, array("server", "username", "password"), true)) {
			return "<input type='hidden' name='auth[" . $name . "]' value=''>\n";
		}
		return $value;
	}
}