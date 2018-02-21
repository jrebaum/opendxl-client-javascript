'use strict'

/**
 * @module CliTestHelpers
 * @private
 */

var fs = require('fs')
var program = require('commander')
var cli = require('../../lib/_cli')
var events = require('events')
var inherits = require('inherits')
var os = require('os')
var querystring = require('querystring')
var pki = require('../../lib/_cli/pki')

var CLI_OUTPUT_VERBOSITY = 0

function runOpenSslCommand (description, openSslCliArgs, input) {
  return pki.runOpenSslCommand(description, openSslCliArgs, null,
    CLI_OUTPUT_VERBOSITY, input).stdout.toString()
}

function HttpRequestStub () {
  events.EventEmitter.call(this)
}

inherits(HttpRequestStub, events.EventEmitter)

function HttpResponseStub (statusCode) {
  this.statusCode = statusCode || 404
  this.headers = {}
  this.resume = function () {}
  events.EventEmitter.call(this)
}

inherits(HttpResponseStub, events.EventEmitter)

module.exports = {
  /**
   * Returns the expected line separator for the current operating system
   */
  LINE_SEPARATOR: os.platform() === 'win32' ? '\r\n' : '\n',
  /**
   * Constructs a Commander command object with subcommands registered.
   * @returns {Command}
   */
  cliCommand: function () {
    var command = new program.Command()
    command.verbose = CLI_OUTPUT_VERBOSITY
    if (!CLI_OUTPUT_VERBOSITY) {
      command.quiet = true
    }
    cli(command)
    return command
  },
  /**
   * Gets the Subject from an X509 Certificate Signing Request.
   * @param {String} csrFileName - Name of the CSR file to read.
   */
  getCsrSubject: function (csrFileName) {
    var result = runOpenSslCommand('Getting csr subject', ['req', '-in',
      csrFileName, '-noout', '-subject'])
    var subject = result.match(/^subject=(.*)/)
    if (!subject) {
      throw new Error('Invalid subject format for csr (' + csrFileName + '): ' +
        result)
    }
    return subject[1]
  },
  /**
   * Gets all of the subject alternative names from an X509 Certificate Signing
   * Request.
   * @param {String} csrFileName - Name of the CSR file to read.
   * @returns {Array<String>} - List of subject alternative names
   */
  getSubjectAlternativeNames: function (csrFileName) {
    var result = runOpenSslCommand('Getting csr subjAltNames', ['req', '-in',
      csrFileName, '-noout', '-text'])
    var subjectAltNameExtension = result.match(
      /X509v3 Subject Alternative Name:[^\n]*[\s]*([^\n]*)/)
    var subjectAltNames = []
    if (subjectAltNameExtension) {
      subjectAltNames = subjectAltNameExtension[1].split(', ')
    }
    return subjectAltNames
  },
  /**
   * Validates that the supplied file is a valid RSA private key.
   * @param {String} privateKeyFileName - Name of the private key file to
   *   validate.
   * @param {String} [input=] - Optional standard input to provide to the
   *   openssl command.
   * @throws {Error} If the file is not a valid RSA private key.
   */
  validateRsaPrivateKey: function (privateKeyFileName, input) {
    if (!fs.existsSync(privateKeyFileName)) {
      throw new Error('Cannot find private key file: ' + privateKeyFileName)
    }
    var privateKey = fs.readFileSync(privateKeyFileName)
    var checkArgs = ['rsa', '-in', privateKeyFileName, '-check']
    if (privateKey.indexOf('ENCRYPTED PRIVATE KEY-') > -1) {
      checkArgs.push('-passin')
      checkArgs.push('stdin')
    }
    var result = runOpenSslCommand('Checking private key', checkArgs,
      input || '')
    if (!result.match('RSA key ok') ||
      !result.match('-BEGIN RSA PRIVATE KEY-')) {
      throw new Error('Invalid RSA private key (' + privateKeyFileName + '): ' +
        result)
    }
  },
  /**
   * Returns a function which, when called, creates a stub for mocking responses
   * from a management service.
   * @param {Object} requestStubs - Keys representing an HTTP path to match
   *   against a request made to the management service and corresponding
   *   function to invoke with the request options. The value returned by the
   *   function, which should be a string, is used as the response.
   * @param {String} [cookie] - Optional value used by the server as a session
   *   cookie for requests.
   * @returns {Function} Function which creates a management service stub
   *   when invoked.
   */
  createManagementServiceStub: function (requestStubs, cookie) {
    if (typeof cookie === 'undefined') {
      cookie = 'omnomnom'
    }
    return function (requestOptions, responseCallback) {
      var response = new HttpResponseStub()
      var responseData = ''
      // Validate the cookie in the request. If the cookie is present and
      // matches the expected value, the request is considered authorized.
      // If the cookie is not present, redirect to a 'login' URL which
      // provides the cookie. The cookie logic exists in the stub to exercise
      // the redirection and cookie management in the CLI command requests.
      if (requestOptions.headers && requestOptions.headers.cookie) {
        if (requestOptions.headers.cookie === cookie) {
          var pathMatch = requestOptions.path.match(/(.*)\?/)
          if (pathMatch && requestStubs[pathMatch[1]]) {
            // Cookie is valid and the request path matches one of the
            // paths in the requestStubs parameter. Route the request to
            // request function.
            response.statusCode = 200
            responseData = 'OK:\r\n' + JSON.stringify(
              requestStubs[pathMatch[1]](requestOptions))
            responseCallback(response)
          } else {
            response.statusCode = 404
            responseData = 'Unknown request path: ' + pathMatch[1]
          }
        } else {
          response.statusCode = 403
          responseCallback(response)
          response.emit('data', 'Unexpected cookie received in request: ' +
            requestOptions.headers.cookie)
        }
      } else {
        response.statusCode = 302
        var nextPath = requestOptions.path.match(/login\?next=(.*)/)
        if (nextPath) {
          response.headers['set-cookie'] = cookie
          response.headers.location = querystring.unescape(nextPath[1])
        } else {
          response.headers.location = '/login?next=' +
            querystring.escape(requestOptions.path)
        }
        responseCallback(response)
      }
      response.emit('data', responseData)
      response.emit('end')
      return new HttpRequestStub()
    }
  }
}
