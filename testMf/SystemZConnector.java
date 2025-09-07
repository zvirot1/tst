import java.io.*;
import com.ibm.etools.marshall.util.*;
import com.ibm.connector2.cics.*;
import com.ibm.zosconnect.api.*;
import com.ibm.zosmf.api.*;

public class SystemZConnector {
    private ZosmfRestClient zosmfClient;
    private ZosConnectService zosConnect;
    private String host;
    private String userId;
    private String password;
    
    public SystemZConnector(String host, String userId, String password) {
        this.host = host;
        this.userId = userId;
        this.password = password;
        this.zosmfClient = new ZosmfRestClient(host + ":443", userId, password);
        this.zosConnect = new ZosConnectService(host + ":9080");
    }
    
    public void connectAndReadCobol(String dataset, String member) throws Exception {
        System.out.println("מתחבר ל-IBM System z mainframe: " + host);
        
        // Method 1: Using z/OSMF REST API
        readWithZosmf(dataset, member);
        
        // Method 2: Using z/OS Connect
        readWithZosConnect(dataset, member);
        
        // Method 3: Using CICS ECI
        readWithCicsEci(dataset, member);
    }
    
    private void readWithZosmf(String dataset, String member) throws Exception {
        System.out.println("שיטה 1: z/OSMF REST API");
        
        String datasetName = dataset + "(" + member + ")";
        ZosmfDatasetRequest request = new ZosmfDatasetRequest();
        request.setDatasetName(datasetName);
        
        ZosmfDatasetResponse response = zosmfClient.getDatasetContent(request);
        
        System.out.println("תוכן תוכנית COBOL מ-z/OSMF:");
        System.out.println(response.getContent());
    }
    
    private void readWithZosConnect(String dataset, String member) throws Exception {
        System.out.println("שיטה 2: z/OS Connect");
        
        ZosConnectRequest request = new ZosConnectRequest();
        request.setServiceName("READ-cobol-service");
        request.addParameter("dataset", dataset);
        request.addParameter("member", member);
        
        ZosConnectResponse response = zosConnect.invoke(request);
        System.out.println("תוכן תוכנית COBOL:");
        System.out.println(response.getResponseData());
    }
    
    private void readWithCicsEci(String dataset, String member) throws Exception {
        System.out.println("שיטה 3: CICS ECI");
        
        ECIRequest eciRequest = new ECIRequest(ECIRequest.ECI_SYNC, "CICS", "", "READCOBL");
        
        // Prepare COMMAREA with dataset and member info
        String commarea = dataset + member;
        eciRequest.setCommarea(commarea.getBytes());
        
        int rc = eciRequest.issue();
        if (rc == ECIRequest.ECI_NO_ERROR) {
            String result = new String(eciRequest.getCommarea());
            System.out.println("תוכן תוכנית COBOL:");
            System.out.println(result);
        } else {
            throw new Exception("CICS ECI Error: " + rc);
        }
    }
}
