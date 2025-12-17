########################################
# Build Stage: Compiles TypeScript app
########################################
FROM node:20 AS builder

# Set working directory inside the container
WORKDIR /app

# Copy all files (you can fine-tune with a .dockerignore)
COPY . .

# Install all dependencies, including dev (for TypeScript, etc.)
RUN npm install

# Compile TypeScript → JavaScript (output goes to /app/dist)
RUN npm run build



########################################
# Final Stage: Lightweight runtime image
########################################
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Only copy compiled JS code and necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install only production dependencies to keep image small
RUN npm install --omit=dev

# Expose the port your SFTP server listens on
EXPOSE 22

# Default command to run your SFTP server
CMD ["node", "dist/sftp-server.js"]
