/** @type {import('tailwindcss').Config} */
module.exports = {
	darkMode: ["class"],
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	theme: {
		extend: {
			keyframes: {
				"accordion-down": {
					from: { height: "0" },
					to: { height: "var(--radix-accordion-content-height)" },
				},
				"accordion-up": {
					from: { height: "var(--radix-accordion-content-height)" },
					to: { height: "0" },
				},
				"record-pulse": {
					"0%, 100%": { boxShadow: "0 0 8px rgba(239, 68, 68, 0.15)" },
					"50%": { boxShadow: "0 0 16px rgba(239, 68, 68, 0.4)" },
				},
				"mic-panel-in": {
					from: { opacity: "0", transform: "translateY(4px)" },
					to: { opacity: "1", transform: "translateY(0)" },
				},
			},
			animation: {
				"accordion-down": "accordion-down 0.2s ease-out",
				"accordion-up": "accordion-up 0.2s ease-out",
				"record-pulse": "record-pulse 1.5s ease-in-out infinite",
				"mic-panel-in": "mic-panel-in 0.15s ease-out",
			},
			boxShadow: {
				"hud-bar": "0 2px 16px rgba(0, 0, 0, 0.25), 0 0 40px rgba(100, 80, 200, 0.08)",
				"mic-panel": "0 2px 12px rgba(0, 0, 0, 0.2), 0 0 30px rgba(100, 80, 200, 0.06)",
			},
			borderRadius: {
				lg: "var(--r-lg)",
				md: "var(--r-md)",
				sm: "var(--r-sm)",
			},
			colors: {
				background: "var(--bg)",
				foreground: "var(--fg)",
				card: {
					DEFAULT: "var(--surface)",
					foreground: "var(--fg)",
				},
				popover: {
					DEFAULT: "var(--surface-hi)",
					foreground: "var(--fg)",
				},
				primary: {
					DEFAULT: "var(--brand)",
					foreground: "var(--accent-on)",
				},
				secondary: {
					DEFAULT: "var(--surface-2)",
					foreground: "var(--fg-2)",
				},
				muted: {
					DEFAULT: "var(--surface-2)",
					foreground: "var(--muted)",
				},
				accent: {
					DEFAULT: "var(--accent)",
					foreground: "var(--accent-on)",
				},
				destructive: {
					DEFAULT: "var(--danger)",
					foreground: "#ffffff",
				},
				border: "var(--border)",
				input: "var(--border)",
				ring: "var(--editor-accent)",
				chart: {
					1: "hsl(var(--chart-1))",
					2: "hsl(var(--chart-2))",
					3: "hsl(var(--chart-3))",
					4: "hsl(var(--chart-4))",
					5: "hsl(var(--chart-5))",
				},
			},
		},
	},
	plugins: [require("tailwindcss-animate")],
};
