node {
  
    stage('Clone Repository') {

        checkout scm       
    }

    stage('Build and Push Docker Image') {

        def dockerfile = 'Dockerfile' 
        def customImage = docker.build("budakdigital/wmr:${env.JOB_BASE_NAME}-${env.BUILD_NUMBER}", "-f ./${dockerfile} .") 
 
        docker.withRegistry('https://registry-1.docker.io', 'budakdigital-dockerhub-credential') {     
            customImage.push("${env.JOB_BASE_NAME}-${env.BUILD_NUMBER}")
        } 
    }

    stage('Deploy into 18.132.36.78 / 10.10.1.125') { 
        sshagent(credentials : ['jenkins-deployer']) {
            withCredentials([usernamePassword( credentialsId: 'postgres-db-credentials', usernameVariable: 'USERNAME', passwordVariable: 'PASSWORD')]) {
                sh "ssh -o StrictHostKeyChecking=no jenkins@10.10.1.125 \"docker pull budakdigital/wmr:${env.JOB_BASE_NAME}-${env.BUILD_NUMBER}\""
                sh "ssh -o StrictHostKeyChecking=no jenkins@10.10.1.125 \"docker stop ${env.JOB_BASE_NAME} && docker rm ${env.JOB_BASE_NAME}\" || true"
                sh "ssh -o StrictHostKeyChecking=no jenkins@10.10.1.125 \"docker run -d -e \"DB_USER=${USERNAME}\" -e \"DB_PASSWORD=${PASSWORD}\" -e \"DB_HOST=10.10.1.4\" -e \"DB_NAME=wmr\" --name=${env.JOB_BASE_NAME} -p 46991:46991 -p 46992:46992 --restart unless-stopped budakdigital/wmr:${env.JOB_BASE_NAME}-${env.BUILD_NUMBER}\""
            }
        }
    }

    stage('Clean Workspace') {
        sh "rm -rf ${env.WORKSPACE}/*"     
    }

    stage('Remove Unused docker image') {
        sh "docker rmi budakdigital/wmr:${env.JOB_BASE_NAME}-${env.BUILD_NUMBER}"
    }    
}
