//Credit Interstellar
//EDIT THIS TO ADD PASSWORD PROTECTION AND TOR SETTINGS
const config = {
	challenge: false, // Set to true if you want to enable password protection.
	users: {
		// You can add multiple users by doing username: 'password'.
		inkshower: "isdabest",
	},

	// Tor Network Configuration
	// enabled: TRUE = Force Tor for all bare requests | FALSE = Direct connection by default (user can still opt-in via cookie)
	tor: {
		enabled: false,
		proxy: "socks5h://127.0.0.1:9050", // Your Tor proxy address
	},
};

export default config;
