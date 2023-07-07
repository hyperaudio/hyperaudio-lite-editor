/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "*.{html,js}",
    "js/*.{html,js}",
  ],
  theme: {
    extend: {},
  },
  plugins: [
    //require("tailwindcss"),
    //require("autoprefixer"),
    require("daisyui"),
  ],
};
