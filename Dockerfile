# syntax=docker/dockerfile:1

FROM node:20-alpine

# Set destination for COPY
WORKDIR /app

# Install dependencies for node-pty and general utilities
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    bash \
    curl \
    git \
    vim \
    nano \
    openssh-client \
    sudo

# Copy package files first for better caching
COPY container_src/package.json container_src/package-lock.json ./

# Install dependencies using npm ci for faster, reliable builds
RUN npm ci --production --no-optional

# Copy container source code
COPY container_src/server.js ./

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Set up sudo for the nodejs user (for terminal access)
RUN echo 'nodejs ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Create home directory and set permissions
RUN mkdir -p /home/nodejs && chown nodejs:nodejs /home/nodejs

# Expose the port
EXPOSE 8080

# Switch to non-root user
USER nodejs

# Set the working directory for the user
WORKDIR /home/nodejs

# Run the server
CMD ["node", "/app/server.js"]