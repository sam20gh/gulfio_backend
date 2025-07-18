# Use official Node.js image
FROM node:18

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy app source code
COPY . .

# Expose your app port
EXPOSE 8080

# Command to run your app
CMD ["npm", "start"]
