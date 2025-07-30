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

# Copy package files and install dependencies
COPY container_src/package*.json ./
RUN npm install --production

# Copy container source code
COPY container_src/server.js ./

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 -G nodejs

# Set up sudo for the nodejs user (for terminal access)
RUN echo 'nodejs ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Expose the port
EXPOSE 8080

# Switch to non-root user
USER nodejs

# Run the server
CMD ["node", "server.js"]