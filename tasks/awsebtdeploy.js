/*
 * grunt-awsebtdeploy
 * https://github.com/simoneb/grunt-awsebtdeploy
 *
 * Copyright (c) 2014 Simone Busoli
 * Licensed under the MIT license.
 */

'use strict';

module.exports = function (grunt) {
  var AWS    = require('aws-sdk'),
      path   = require('path'),
      _      = require('lodash'),
      fs     = require('fs'),
      get    = require('http').get,
      sget   = require('https').get,
      util   = require('util'),
      Q      = require('q'),
      mkdirp = require('mkdirp');

  function findEnvironmentByCNAME(data, cname) {
    if (!data || !data.Environments) return false;

    return data.Environments.filter(function (e) {
      return e.CNAME === cname;
    })[0];
  }

  function createEnvironmentName(applicationName) {
    var maxLength       = 23,
        maxAppLength    = maxLength - 4,
        time            = new Date().getTime().toString(),
        timeLength      = time.length,
        // Leaving a few characters at the end of the app name for the timestamp
        applicationName = applicationName.substring(0, Math.min(applicationName.length, maxAppLength)),
        availableSpace  = maxLength - applicationName.length,
        timePart        = time.substring(timeLength - availableSpace, timeLength);

    if (applicationName.length > maxLength - 3)
      grunt.log.subhead('Warning: application name is too long to guarantee ' +
          'a unique environment name, maximum length ' +
          maxLength + ' characters');

    if (/^[a-zA-Z0-9\-]+$/.test(applicationName))
      return applicationName + timePart;

    grunt.log.subhead('Notice: application name contains invalid characters ' +
        'for a environment name; stripping everything non letter, digit, or dash');
    return applicationName.replace(/[^a-zA-Z0-9\-]+/g, "") + timePart;
  }

  function wrapAWS(eb, s3, r53, elb, ec2) {
    return {
      describeApplications: Q.nbind(eb.describeApplications, eb),
      describeEnvironments: Q.nbind(eb.describeEnvironments, eb),
      describeEnvironmentResources: Q.nbind(eb.describeEnvironmentResources, eb),
      putS3Object: Q.nbind(s3.putObject, s3),
      headObject: Q.nbind(s3.headObject, s3),
      createApplicationVersion: Q.nbind(eb.createApplicationVersion, eb),
      updateEnvironment: Q.nbind(eb.updateEnvironment, eb),
      createConfigurationTemplate: Q.nbind(eb.createConfigurationTemplate, eb),
      swapEnvironmentCNAMEs: Q.nbind(eb.swapEnvironmentCNAMEs, eb),
      createEnvironment: Q.nbind(eb.createEnvironment, eb),
      terminateEnvironment: Q.nbind(eb.terminateEnvironment, eb),
      deleteConfigurationTemplate: Q.nbind(eb.deleteConfigurationTemplate, eb),
      // Route 53
      getChange: Q.nbind(r53.getChange, r53),
      listResourceRecordSets: Q.nbind(r53.listResourceRecordSets, r53),
      changeResourceRecordSets: Q.nbind(r53.changeResourceRecordSets, r53),
      // Elastic Load Balancing
      describeLoadBalancers: Q.nbind(elb.describeLoadBalancers, elb),
      // EC2
      describeInstances: Q.nbind(ec2.describeInstances, ec2)
    };
  }

  function setupAWSOptions(options) {
    if (!options.accessKeyId && process.env.AWS_ACCESS_KEY_ID) {
        options.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    }
    if (!options.secretAccessKey && process.env.AWS_SECRET_ACCESS_KEY) {
        options.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    }

    return {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region
    };
  }

  grunt.registerMultiTask('awsebtlogs', 'Retrieve logs from AWS Elastic Beanstalk', function () {
    if (!this.data.options.environmentName) grunt.warn('Missing "environmentName"');
    if (!this.data.options.region) grunt.warn('Missing "region"');

    var done = this.async(),
        options = this.options({
          outputPath: './',
          timeoutSec: 30,
          intervalSec: 2
        }),
        awsOptions = setupAWSOptions(options),
        eb         = new AWS.ElasticBeanstalk(awsOptions),
        request    = Q.nbind(eb.requestEnvironmentInfo, eb),
        retrieve   = Q.nbind(eb.retrieveEnvironmentInfo, eb),
        args       = { EnvironmentName: options.environmentName, InfoType: 'tail' };

    grunt.log.writeln('Requesting logs for environment ' + options.environmentName + '...');

    request(args)
        .then(function (data) {
          var requestId = data.ResponseMetadata.RequestId;

          function doRetrieve() {
            return Q.delay(options.intervalSec * 1000)
                .then(function () {
                  return retrieve(args);
                })
                .then(function (data) {
                  var deferred = Q.defer(),
                      found = data.EnvironmentInfo.filter(function (info) {
                        return info.BatchId === requestId;
                      });

                  if (!found || !found.length) {
                    grunt.log.writeln('Still waiting for logs...');
                    deferred.resolve(doRetrieve());
                  } else {
                    deferred.resolve(Q.all(found.map(function (info) {
                      var outputPath = path.join(options.outputPath, info.BatchId),
                          batchDeferred = Q.defer();

                      sget(info.Message, function (res) {
                        var data = [];
                        res.on('data', function (chunk) {
                          data.push(chunk);
                        });
                        res.on('end', function () {
                          mkdirp.sync(outputPath);

                          var fileName = path.join(outputPath, info.Name);
                          grunt.log.writeln('Writing log file for EC2 instance ' +
                              info.Ec2InstanceId + ' to ' + fileName);

                          fs.writeFile(fileName, data, function (err) {
                            if (err) return batchDeferred.reject(err);

                            grunt.log.ok();
                            batchDeferred.resolve();
                          });
                        });
                        res.on('error', function (err) {
                          batchDeferred.reject(err);
                        });
                      });

                      return batchDeferred.promise;
                    })));
                  }

                  return deferred.promise;
                });
          }

          return Q.timeout(doRetrieve(), options.timeoutSec * 1000);
        })
        .then(done, done);
  });

  grunt.registerMultiTask('awsebtdeploy', 'A grunt plugin to deploy applications to AWS Elastic Beanstalk', function () {

    function validateOptions() {
      if (!options.applicationName) grunt.warn('Missing "applicationName"');
      if (!options.environmentCNAME) grunt.warn('Missing "environmentCNAME"');
      if (!options.region) grunt.warn('Missing "region"');

      if (!options.s3) {
        options.s3 = {};
      }

      if (!options.s3.key && !grunt.file.isFile(options.sourceBundle))
        grunt.warn('"sourceBundle" points to a non-existent file');

      if (!options.healthPage) {
        grunt.log.subhead('Warning: "healthPage" is not set, it is recommended to set one');
      } else if (options.healthPage[0] !== '/') {
        options.healthPage = '/' + options.healthPage;
      }

      if (!options.healthPageScheme) {
        options.healthPageScheme = 'http';
      } else if (options.healthPageScheme !== 'http' && options.healthPageScheme !== 'https') {
        grunt.warn('"healthPageScheme" only accepts "http" or "https", reverting to "http"');
        options.healthPageScheme = 'http';
      }

      if (!options.s3.bucket) {
        options.s3.bucket = options.applicationName;
      }

      if (!options.s3.key) {
        options.s3.key = path.basename(options.sourceBundle);
      }

      if (!options.versionLabel) {
        options.versionLabel = path.basename(options.s3.key,
            path.extname(options.s3.key));
      }

      if (options.r53Records && !_.isArray(options.r53Records)) {
        grunt.warn('"r53Records must be an array of objects');
      }

      if (options.r53Records && !options.hostedZone) {
        grunt.warn('No "hostedZone" supplied for r53Records');
      }

      if (options.r53Records) {
        var invalidRecords = _.filter(options.r53Records, function (item) {
          return item.type !== 'CNAME' && item.type !== 'A';
        });

        if (invalidRecords.length) {
          grunt.log.writeln('Invalid records: ');
          grunt.log.write(invalidRecords);
          grunt.warn('r53Records must have a type of A or CNAME');
        }
      }
    }

    var task    = this,
        done    = this.async(),
        options = this.options({
          versionDescription: '',
          deployType: 'inPlace',
          deployTimeoutMin: 10,
          deployIntervalSec: 20,
          healthPageTimeoutMin: 5,
          healthPageIntervalSec: 10
        }),
        awsOptions = setupAWSOptions(options),
        qAWS       = wrapAWS(
          new AWS.ElasticBeanstalk(awsOptions),
          new AWS.S3(awsOptions),
          new AWS.Route53(awsOptions),
          new AWS.ELB(awsOptions),
          new AWS.EC2(awsOptions)
        );

    validateOptions();

    grunt.log.subhead('Operating in region "' + options.region + '"');

    function createConfigurationTemplate(env) {
      grunt.log.write('Creating configuration template of current environment for swap deploy...');

      var templateName = options.applicationName + '-' + new Date().getTime();

      return qAWS.createConfigurationTemplate({
        ApplicationName: options.applicationName,
        EnvironmentId: env.EnvironmentId,
        TemplateName: templateName
      }).then(function (data) {
            grunt.log.ok();
            return [env, data];
          });
    }

    function createNewEnvironment(env, templateData) {
      var newEnvName = createEnvironmentName(options.applicationName);

      grunt.log.write('Creating new environment "' + newEnvName + '"...');

      return qAWS.createEnvironment({
        ApplicationName: options.applicationName,
        EnvironmentName: newEnvName,
        VersionLabel: options.versionLabel,
        TemplateName: templateData.TemplateName
      }).then(function (data) {
            grunt.log.ok();
            return [env, data, templateData];
          });
    }

    function swapEnvironmentCNAMEs(oldEnv, newEnv) {
      grunt.log.write('Swapping environment CNAMEs...');

      return qAWS.swapEnvironmentCNAMEs({
        SourceEnvironmentName: oldEnv.EnvironmentName,
        DestinationEnvironmentName: newEnv.EnvironmentName
      }).then(function () {
            grunt.log.ok();
            grunt.log.writeln();
            return oldEnv;
          });
    }

    function swapDeploy(env) {
      return createConfigurationTemplate(env)
          .spread(createNewEnvironment)
          .spread(function (oldEnv, newEnv, templateData) {
            return waitForDeployment(newEnv)
                .then(waitForHealthPage)
                .then(swapAndWait.bind(task, oldEnv, newEnv))
                /* Not ideal binding here. The CNAMEs for environments do not get updated in this script after
                 * they are swapped so we have to wait for the health page of the environment at the CNAME
                 * of the oldEnv since that is now swapped to the newEnv.
                 */
                .then(waitForHealthPage.bind(task, oldEnv))
                // Deploy to oldEnv now that traffic is going to newEnv
                .then(updateEnvironment.bind(task, oldEnv))
                .then(waitForDeployment)
                /* Wait for the health page of the environment at the CNAME
                 * of the newEnv since that is now swapped to the oldEnv.
                 */
                .then(waitForHealthPage.bind(task, newEnv))
                // Swap everything back from newEnv to oldEnv
                .then(swapAndWait.bind(task, newEnv, oldEnv))
                /* Wait for the health page of the environment at the CNAME
                 * of the oldEnv since that is now back to oldEnv.
                 */
                .then(waitForHealthPage.bind(task, oldEnv))
                // Terminate newEnv
                .then(terminateEnvironment.bind(task, newEnv))
                // Delete the configuration template that we created for the new env
                .then(deleteConfigurationTemplate.bind(task, templateData))
          });
    }

    /**
     * Swaps all traffic from fromEnv to toEnv. This handles standard CNAME swapping with
     * Beanstalk as well as Route53 swapping if options.r53Records is defined and an
     * options.hostedZone has been given. If R53 records are supplied, the records will
     * be moved with swapR53Records. If no records are supplied, but a hostedZone is
     * supplied, any DNS records in that hosted zone with a value of the toEnv's CNAME
     * (e.g. a CNAME myapp.example.com pointing to myapp-env.elasticbeanstalk.com) will
     * be checked for a max TTL value. This will wait the max of this TTL and the TTLs
     * of any records in options.r53Records. Additionally, it will wait for both
     * environments to be green and ready using waitForGreen. This ensures beanstalk
     * operations can be taken on the environment after the swap since beanstalk puts them
     * in an inoperable state during the swap.
     *
     * Fulfilled promise returns the fromEnv.
     *
     * @param {object} fromEnv Env object for the env we're moving traffic FROM.
     * @param {object} toEnv   Env object for the env we're moving traffic TO.
     *
     * @return {promise} Promise fulfilled when CNAMEs and optional R53 records are swapped
     *                           and TTLs for the DNS records have expired.
     */
    function swapAndWait (fromEnv, toEnv) {
      return swapEnvironmentCNAMEs(fromEnv, toEnv)
            .then(function (fromEnv) {
              // If we have an R53 zone, find the max TTL of all CNAMEs that point to the environment CNAME
              if (options.hostedZone) {
                grunt.log.debug("Have Route53 zone. Finding all CNAMEs that point to " + options.environmentCNAME);

                return findMaxTTL(options.environmentCNAME)
                  // Then wait out the max TTL
                  .then(function (ttl) {
                    // If we have R53 settings, move the defined R53 records to point to the new load balancer/instance
                    if (options.r53Records && options.r53Records.length) {
                      // Pass in the max ttl from before and wait for at least that long
                      return swapR53Records(fromEnv, toEnv, ttl);
                    } else {
                      // If we have no R53 settings, just delay for the CNAME TTLs
                      ttl += 30;

                      // Delaying an additional 30 seconds
                      grunt.log.writeln("Waiting out DNS caches for CNAMES that point to " + options.environmentCNAME + ": " + ttl + ' seconds');
                      return Q.delay(ttl * 1000).then(function () {
                        grunt.log.ok();
                        return fromEnv;
                      });
                    }

                  })
              }

              // If we have no Route53 settings, carry on
              return fromEnv;
            })
            .then(waitForGreen.bind(this, toEnv))
            .then(waitForGreen.bind(this, fromEnv));
    }

    /**
     * Swaps the Route53 records for this deploy from pointing at fromEnv to point to
     * toEnv. This first describes the resources for toEnv to determine the load
     * balancers (if any) or the instance (if it's a single instance environment).
     *
     * Any Alias records are changed to point to the load balancer (Note: only
     * supports one LB) if the environment has one. Non-alias types will take the DNS
     * name of the load balancer or the EC2 instance for single-instance environments.
     *
     * This function waits out the max TTL of the chagned records or of the given minTTL
     * so that when the promise is fulfilled, all traffic should be going to toEnv.
     *
     * Fulfilled promise returns the toEnv.
     *
     * @param {object} fromEnv Env object for the env we're moving traffic FROM.
     * @param {object} toEnv   Env object for the env we're moving traffic TO.
     * @param {int} minTTL  Optional minTTL in seconds to wait after changes.
     *
     * @return {promise} A promise fulfilled after records are changed and TTLs have expired.
     */
    function swapR53Records (fromEnv, toEnv, minTTL) {
      if (!options.r53Records || options.r53Records.length === 0) {
        return fromEnv;
      }

      grunt.log.writeln('Moving DNS records from ' + fromEnv.EnvironmentName + ' to ' + toEnv.EnvironmentName + '...');

      // First describe the resources of the destination env to see if it has a load balancer
      return qAWS.describeEnvironmentResources({
        EnvironmentName: toEnv.EnvironmentName,
        EnvironmentId: toEnv.EnvironmentId
      }).then(function (toEnvResources) {

        // If it has a load balancer, add that to the list of info we'll need
        var numLoadBalancers = toEnvResources.EnvironmentResources.LoadBalancers.length,
          hasLoadBalancer = 0 < numLoadBalancers,
          infoPromises = [],
          lbNames = [];

        grunt.log.debug(numLoadBalancers + " load balancers so " + hasLoadBalancer);

        if (hasLoadBalancer) {
          for (var lb = 0; lb < numLoadBalancers; lb++) {
            lbNames.push(toEnvResources.EnvironmentResources.LoadBalancers[lb].Name);
          }

          grunt.log.debug("Load balancer names: ");
          grunt.log.debug(lbNames);

          infoPromises.push(qAWS.describeLoadBalancers({
            LoadBalancerNames: lbNames
          }));
        } else {
          // Assuming single instance if there's no load balancer
          if (toEnvResources.EnvironmentResources.Instances.length !== 1) {
            grunt.fail.warn(toEnvResources.EnvironmentResources.Instances.length + ' instances found for ' + toEnv.EnvironmentName + '. Expected 1.');
          }

          infoPromises.push(qAWS.describeInstances({
            InstanceIds: [
              toEnvResources.EnvironmentResources.Instances[0].Id
            ]
          }));
        }

        // Get R53 info for each record we have
        for (var i = 0; i < options.r53Records.length; i++) {
          var recordOpt = options.r53Records[i];

          infoPromises.push(
            qAWS.listResourceRecordSets({
              HostedZoneId: options.hostedZone,
              StartRecordName: recordOpt.name,
              StartRecordType: recordOpt.type,
              MaxItems: '1'
            })
          );
        }

        return Q.all(infoPromises).spread(function () {
          var results = Array.prototype.slice.call(arguments),
            changeRequests = [],
            lbInfo,
            instanceInfo,
            resourceResults = results[0],
            maxTTL = minTTL || 0;

          results = results.slice(1);

          if (hasLoadBalancer) {
            if (0 < resourceResults.LoadBalancerDescriptions.length) {
              lbInfo = resourceResults.LoadBalancerDescriptions[0];
            } else {
              grunt.fail.warn('No load balancer info found for new environment ' + toEnv.EnvironmentName);
            }

          } else {
            if (0 < resourceResults.Reservations.length && 0 < resourceResults.Reservations[0].Instances.length) {
              instanceInfo = resourceResults.Reservations[0].Instances[0];
            } else {
              grunt.fail.warn('No instance info yet for new envrionment: ' + toEnv.EnvironmentName);
            }
          }

          for (var j = 0; j < results.length; j++) {
            // We should only have 1 result per query
            if (results[j].ResourceRecordSets.length === 1) {
              var oldRecord = results[j].ResourceRecordSets[0];
              var newRecord = _.cloneDeep(oldRecord);
              var newDNSName;

              if (oldRecord.TTL) {
                maxTTL = Math.max(maxTTL, oldRecord.TTL);
              }

              if (oldRecord.AliasTarget) {
                if (!hasLoadBalancer) {
                  grunt.log.error("Cannot use alias record with single instance. Use non-aliased CNAME instead.");
                  continue;
                }

                // Point the alias target to the new load balancer
                newDNSName = lbInfo.DNSName;
                newRecord.AliasTarget.DNSName = newDNSName;
                newRecord.AliasTarget.HostedZoneId = lbInfo.CanonicalHostedZoneNameID;

                // AWS puts an empty array here in their API response but will not accept it with an AliasTarget
                delete newRecord.ResourceRecords;
              } else {
                newDNSName = hasLoadBalancer ? lbInfo.DNSName : instanceInfo.PublicDnsName;

                // Point the value to the load balancer or instance DNS name
                newRecord.ResourceRecords = [{
                  Value: newDNSName
                }];
              }

              grunt.log.debug('Old record: ');
              grunt.log.debug(JSON.stringify(oldRecord));
              grunt.log.debug('New record: ');
              grunt.log.debug(JSON.stringify(newRecord));

              grunt.log.writeln("Updating " + oldRecord.Name + ' to ' + newDNSName + '...');

              changeRequests.push({
                Action: 'UPSERT',
                ResourceRecordSet: newRecord
              });
            }
          }

          // Wait for the records to change and then wait out the TTL
          return qAWS.changeResourceRecordSets({
                HostedZoneId: options.hostedZone,
                ChangeBatch: {
                  Changes: changeRequests
                }
              })
            .then(waitForRecordSync)
            .then((function () {
              grunt.log.ok();

              maxTTL += 30;

              grunt.log.writeln("Pausing for DNS caches to expire: " + maxTTL + ' seconds...');
              return Q.delay(maxTTL * 1000).then(function () {
                grunt.log.ok();
                return fromEnv;
              });
            }).bind(task));
        });
      });
    }

    /**
     * Waits for the given Route53 change batch to complete (become INSYNC).
     *
     * @param {object} changeResult Comes from the response of R53.changeResourceRecordSets
     *
     * @return {promise} Q promise.
     */
    function waitForRecordSync (changeResult) {
      var changeId = changeResult.ChangeInfo.Id;
      grunt.log.writeln('Waiting for Route53 DNS changes to complete (timing out in ' +
          options.deployTimeoutMin + ' minutes)...');

      function checkChangeStatus () {
        return Q.delay(10 * 1000)
          .then(function () {
            return qAWS.getChange({
              Id: changeId
            });
          })
          .then(function (changeUpdate) {
            if (changeUpdate.ChangeInfo.Status.toUpperCase() !== 'INSYNC') {
              grunt.log.writeln('DNS changes still PENDING...');
              return checkChangeStatus();
            }

            grunt.log.writeln('DNS changes ' + changeUpdate.ChangeInfo.Status);

            return true;
          });
      }

      return Q.timeout(checkChangeStatus(), options.deployTimeoutMin * 60 * 1000);
    }

    /**
     * Returns the max TTL value of CNAME records in the given Route53 hosted zone
     * that have the given value.
     *
     * @param {String} value The value to search for (e.g. your beanstalk env's CNAME).
     *
     * @return {int} The max TTL of the matching records.
     */
    function findMaxTTL(value) {
      var ttl = 0;
      value = value.toLowerCase();

      return getAllRoute53Records('CNAME').then(function (records) {
        for (var i = 0; i < records.length; i++) {
          var record = records[i];
          var resourceRecords = record.ResourceRecords;

          // Alias records don't have a TTL value
          if (!record.TTL) {
            continue;
          }

          if (resourceRecords.length) {
            for (var j = 0; j < resourceRecords.length; j++) {
              if (resourceRecords[j].Value.toLowerCase() === value) {
                ttl = Math.max(ttl, record.TTL);
              }
            }
          }
        }

        return parseInt(ttl, 10);
      })
    }

    /**
     * Gets all of the Route53 records in options.hostedZone that are of the given type.
     *
     * @param {string} type The record type to filter by. E.g. CNAME.
     *
     * @return {array} An array of records from the hostedZone that match the given type.
     */
    function getAllRoute53Records(type) {
      var allRecords = [];
      type = type.toUpperCase();

      function _getAllRecords(startName, startType) {
        var params = {
          HostedZoneId: options.hostedZone,
          StartRecordName: startName,
          StartRecordType: startType
        };

        return qAWS.listResourceRecordSets(params).then(function (response) {
          for (var i = 0; i < response.ResourceRecordSets.length; i++) {
            var record = response.ResourceRecordSets[i];

            if (record.Type.toUpperCase() === type) {
              allRecords.push(record);
            }
          }

          if (response.IsTruncated) {
            return _getAllRecords(response.NextRecordName, response.NextRecordType);
          } else {
            return allRecords;
          }
        });
      }


      // First have to get 1 record in the zone to find where to start
      return qAWS.listResourceRecordSets({
        HostedZoneId: options.hostedZone,
        MaxItems: '1'
      }).then(function (initialRecord) {
        if (initialRecord.ResourceRecordSets.length) {
          // Next get all the records
          return _getAllRecords(initialRecord.ResourceRecordSets[0].Name, initialRecord.ResourceRecordSets[0].Type);
        } else {
          return [];
        }
      });
    }

    function updateEnvironment(env) {
      grunt.log.writeln("\nUpdating environment " + env.EnvironmentName + ' with version ' + options.versionLabel + '...');
      return qAWS.updateEnvironment({
        EnvironmentName: env.EnvironmentName,
        VersionLabel: options.versionLabel,
        Description: options.versionDescription
      }).then(function () {
            grunt.log.ok();
            grunt.log.writeln();
            return env;
          });
    }

    function inPlaceDeploy(env) {
      grunt.log.write('Updating environment for in-place deploy...');

      return updateEnvironment(env)
          .then(waitForDeployment)
          .then(waitForHealthPage);
    }

    function waitForDeployment(env) {
      grunt.log.writeln('Waiting for environment to deploy new version (timing out in ' +
          options.deployTimeoutMin + ' minutes)...\n');

      var first = true;
      function checkDeploymentComplete() {
        return Q.delay(first ? 0 : options.deployIntervalSec * 1000)
            .then(function () {
              first = false;
              return qAWS.describeEnvironments({
                ApplicationName: options.applicationName,
                EnvironmentNames: [env.EnvironmentName],
                VersionLabel: options.versionLabel,
                IncludeDeleted: false
              });
            })
            .then(function (data) {
              if (!data.Environments.length) {
                grunt.log.writeln(options.versionLabel + ' still not deployed to ' +
                    env.EnvironmentName + ' ...');
                return checkDeploymentComplete();
              }

              var currentEnv = data.Environments[0];

              grunt.log.writeln(options.versionLabel + ' has been deployed to ' +
                  currentEnv.EnvironmentName + ' and environment is Ready and Green\n');

              return currentEnv;
            });
      }

      return Q.fcall(waitForGreen, env)
              .then(function () {
                return Q.timeout(checkDeploymentComplete(), options.deployTimeoutMin * 60 * 1000)
              })
    }

    /**
     * Waits for the given environment to have a health of green and a status of ready.
     * Will timeout in options.deployTimeoutMin minutes.
     *
     * @param {object} env Elastic Beanstalk environment object containing an EnvironmentName.
     *
     * @return {Promise} A Q promise that will be resolved with the env from describeEnvironments.
     */
    function waitForGreen(env) {
      grunt.log.writeln('Waiting for environment to become ready (timing out in ' +
          options.deployTimeoutMin + ' minutes)...\n');

      var first = true;
      function checkEnvReady() {
        return Q.delay(first ? 0 : options.deployIntervalSec * 1000)
            .then(function () {
              first = false;

              return qAWS.describeEnvironments({
                ApplicationName: options.applicationName,
                EnvironmentNames: [env.EnvironmentName],
                IncludeDeleted: false
              });
            })
            .then(function (data) {
              if (!data.Environments.length) {
                grunt.log.writeln('No environment: ' + env.EnvironmentName + ' ...');
                return checkEnvReady();
              }

              var currentEnv = data.Environments[0];

              if (currentEnv.Status !== 'Ready') {
                grunt.log.writeln('Environment ' + currentEnv.EnvironmentName +
                    ' status: ' + currentEnv.Status + '...');
                return checkEnvReady();
              }

              if (currentEnv.Health !== 'Green') {
                grunt.log.writeln('Environment ' + currentEnv.EnvironmentName +
                    ' health: ' + currentEnv.Health + '...');
                return checkEnvReady();
              }

              grunt.log.writeln('Environment "' + currentEnv.EnvironmentName + '" is Ready and Green\n');

              return currentEnv;
            });
      }

      return Q.timeout(checkEnvReady(), options.deployTimeoutMin * 60 * 1000);
    }

    function waitForHealthPage(env) {
      if (!options.healthPage) {
        return;
      }

      function checkHealthPageStatus() {
        grunt.log.write('Checking health page status...');

        var deferred = Q.defer();

        var checkHealthPageRequest = {
          hostname: env.CNAME,
          path: options.healthPage,
          headers: {
            'cache-control': 'no-cache'
          }
        };
        var checkoutHealthPageCallback = function (res) {
          if (res.statusCode === 200) {
            grunt.log.ok();
            deferred.resolve(res);
          } else {
            grunt.log.writeln('Status ' + res.statusCode);
            deferred.resolve(
              Q.delay(options.healthPageIntervalSec * 1000)
               .then(checkHealthPage));
          }
        };
        if (options.healthPageScheme === 'https') {
          //Necessary because ELB's security certificate won't be valid yet.
          checkHealthPageRequest.rejectUnauthorized = false;
          sget(checkHealthPageRequest, checkoutHealthPageCallback);
        } else {
          get(checkHealthPageRequest, checkoutHealthPageCallback);
        }

        return deferred.promise;
      }

      function checkHealthPageContents(res) {
        var body,
            deferred = Q.defer();

        if (!options.healthPageContents) return;

        grunt.log.write('Checking health page contents against ' +
            options.healthPageContents + '...');

        res.setEncoding('utf8');

        res.on('data', function (chunk) {
          if (!body) body = chunk;
          else body += chunk;
        });
        res.on('end', function () {
          var ok;

          if (util.isRegExp(options.healthPageContents)) {
            ok = options.healthPageContents.test(body);
          } else {
            ok = options.healthPageContents === body;
          }

          if (ok) {
            grunt.log.ok();
            deferred.resolve();
          } else {
            grunt.log.error('Got ' + body);
            deferred.resolve(
                Q.delay(options.healthPageIntervalSec * 1000).then(checkHealthPage));
          }
        });

        return deferred.promise;
      }

      function checkHealthPage() {
        return checkHealthPageStatus()
            .then(checkHealthPageContents);
      }

      grunt.log.writeln('Checking health page of ' + env.CNAME +
          ' (timing out in ' + options.healthPageTimeoutMin + ' minutes)...');

      return Q.timeout(checkHealthPage(), options.healthPageTimeoutMin * 60 * 1000);
    }

    function invokeDeployType(env) {
      switch (options.deployType) {
        case 'inPlace':
          return inPlaceDeploy(env);
        case 'swapToNew':
          return swapDeploy(env);
        case 'manual':
          return;
        default:
          grunt.warn('Deploy type "' + options.deployType + '" unrecognized');
      }
    }

    function createApplicationVersion(env) {
      grunt.log.write('Creating application version "' + options.versionLabel + '"...');

      return qAWS.createApplicationVersion({
        ApplicationName: options.applicationName,
        VersionLabel: options.versionLabel,
        Description: options.versionDescription,
        SourceBundle: {
          S3Bucket: options.s3.bucket,
          S3Key: options.s3.key
        }
      }).then(function () {
            grunt.log.ok();
            return env;
          });
    }

    function uploadApplication(env) {
      if (options.sourceBundle) {
        var s3Object = {};

        for (var key in options.s3) {
          if (options.s3.hasOwnProperty(key)) {
            s3Object[key.substring(0, 1).toUpperCase() + key.substring(1)] =
                options.s3[key];
          }
        }

        grunt.verbose.writeflags(s3Object, 's3Param');

      // Trying to fix this issue: https://github.com/aws/aws-sdk-js/issues/158
      s3Object.Body = fs.createReadStream(options.sourceBundle);

        grunt.log.write('Uploading source bundle "' + options.sourceBundle +
            '" to S3 location "' + options.s3.bucket + '/' + options.s3.key + '"...');

        return qAWS.putS3Object(s3Object)
            .then(function () {
              grunt.log.ok();
              return env;
            });
      } else {
        grunt.log.write('Using S3 source bundle in "' + options.s3.bucket + '/' + options.s3.key + '"...')
        grunt.log.ok();
        return env;
      }
    }

    function checkEnvironmentExists() {
      grunt.log.write('Checking that environment with CNAME "' + options.environmentCNAME + '" exists...');

      return qAWS.describeEnvironments({
        ApplicationName: options.applicationName,
        IncludeDeleted: false
      }).then(function (data) {
            grunt.verbose.writeflags(data, 'Environments');

            var env = findEnvironmentByCNAME(data, options.environmentCNAME);

            if (!env) {
              grunt.log.error();
              grunt.warn('Environment with CNAME "' + options.environmentCNAME + '" does not exist');
            }

            grunt.log.ok();
            return env;
          });
    }

    function checkApplicationExists() {
      grunt.log.write('Checking that application "' + options.applicationName + '" exists...');

      return qAWS.describeApplications({ ApplicationNames: [options.applicationName] })
          .then(function (data) {
            grunt.verbose.writeflags(data, 'Applications');

            if (!data.Applications.length) {
              grunt.log.error();
              grunt.warn('Application "' + options.applicationName + '" does not exist');
            }

            grunt.log.ok();
          });
    }

    /**
     * Terminates the given environment in ElasticBeanstalk.
     *
     * @param {object} env Env object for the environment we want to terminate.
     *
     * @return {promise} promise that will be fulfilled when env is terminated.
     */
    function terminateEnvironment (env) {
      var color = 'red';
      var countdown = 10;

      grunt.log.writeln(("Warning: About to terminate environment '" + env.EnvironmentName + "' in " + countdown + " seconds...")[color]);
      var deferred = Q.defer();

      var interval = setInterval(function () {
        grunt.log.writeln(("" + countdown)[color]);

        if (0 === countdown) {
          clearInterval(interval);
          _terminate();
        } else {
          countdown--;
        }
      }, 1000);

      function _terminate () {
        grunt.log.writeln("Terminating '" + env.EnvironmentName + "'");

        deferred.resolve(qAWS.terminateEnvironment({
          EnvironmentId: env.EnvironmentId,
          EnvironmentName: env.EnvironmentName
        }).then(function () {
          grunt.log.ok();
        }));
      }

      return deferred.promise;
    }

    /**
     * Deletes the configuration template given by templateData.TemplateName in the
     * application options.applicationName.
     *
     * @param {object} templateData The data obj for the template we want to delete.
     *
     * @return {promise} Promise fulfilled when the config template is deleted
     */
    function deleteConfigurationTemplate (templateData) {
      grunt.log.writeln("Deleting configuration template: '" + templateData.TemplateName + "'...");

      return qAWS.deleteConfigurationTemplate({
          ApplicationName: options.applicationName,
          TemplateName: templateData.TemplateName
        })
        .then(function () {
          grunt.log.ok();
        });
    }

    return checkApplicationExists()
        .then(checkEnvironmentExists)
        .then(uploadApplication)
        .then(createApplicationVersion)
        .then(invokeDeployType)
        .then(done, done);
  });
};
